"use strict";
(() => {
  // src/main.ts
  var EPSILON = 1e-6;
  var TARGET_SAMPLE_PX = 3;
  var DEFAULT_SOURCE_SMOOTHNESS = 12;
  var OUTPUT_NAME_PREFIX = "Live Vector Path Warp";
  var OUTPUT_SOURCE_NAME = "__Live Vector Path Warp Source Snapshot";
  var OUTPUT_TARGET_NAME = "__Live Vector Path Warp Editable Path";
  var SNAPSHOT_GAP = 24;
  var settings = {
    type: "settings",
    livePreview: true,
    thicknessScale: 1,
    patternOffset: 0,
    smoothness: DEFAULT_SOURCE_SMOOTHNESS,
    pathSmoothing: 2
  };
  var linked = null;
  var renderTimer;
  var isRendering = false;
  var pendingRender = false;
  var pendingRenderForce = false;
  var lastRenderKey = "";
  var detachOutputOnNextRender = false;
  var arrangeSnapshotsOnNextRender = false;
  var autoArrangeSnapshotIds = [];
  figma.showUI(__html__, { width: 320, height: 650, themeColors: true });
  figma.on("selectionchange", () => {
    if (isRendering) return;
    const restored = restoreLinkedOutputFromSelection();
    postSelectionStatus();
    scheduleRender(restored ? "output selection" : "selection", restored ? 20 : 140, restored);
  });
  figma.ui.onmessage = (message) => {
    if (message.type === "start") {
      startFromSelection();
      return;
    }
    if (message.type === "settings") {
      settings = {
        ...settings,
        ...message,
        smoothness: DEFAULT_SOURCE_SMOOTHNESS
      };
      scheduleRender("settings", 20, true);
    }
  };
  void initializeDocumentWatcher();
  var restoredOnLaunch = restoreLinkedOutputFromSelection();
  postSettingsToUi();
  postSelectionStatus();
  if (restoredOnLaunch) scheduleRender("restore on launch", 20, true);
  async function initializeDocumentWatcher() {
    try {
      postStatus("Loading document access for live preview...");
      await figma.loadAllPagesAsync();
      figma.on("documentchange", () => {
        scheduleRender("document");
      });
      if (!isRendering) postSelectionStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not enable document live updates.";
      postStatus(`Live document updates disabled: ${message}`, true);
    }
  }
  function startFromSelection() {
    if (getSelectedOutputFrame()) {
      restoreLinkedOutputFromSelection();
      postStatus("Live frame restored. Editable path is selected.");
      lastRenderKey = "";
      scheduleRender("restore", 20, true);
      return;
    }
    const selection = figma.currentPage.selection.filter((node) => !isCurrentOutput(node));
    if (selection.length !== 2) {
      postStatus("\u041D\u0443\u0436\u043D\u043E \u0432\u044B\u0434\u0435\u043B\u0438\u0442\u044C \u0440\u043E\u0432\u043D\u043E 2 \u0441\u043B\u043E\u044F: source \u0438 vector path.", true);
      return;
    }
    const resolved = resolveSourceAndTarget(selection[0], selection[1]);
    if (!resolved) {
      postStatus("\u0412\u044B\u0434\u0435\u043B\u0438 source layer/frame/component \u0438 target vector path.", true);
      return;
    }
    linked = {
      sourceId: resolved.source.id,
      targetId: resolved.target.id,
      outputId: linked?.outputId,
      outputMeta: linked?.outputMeta,
      sourceFromOutput: false,
      targetFromOutput: false
    };
    detachOutputOnNextRender = linked.outputId !== void 0;
    arrangeSnapshotsOnNextRender = linked.outputId !== void 0;
    lastRenderKey = "";
    postStatus(`Linked: ${resolved.source.name} -> ${resolved.target.name}`);
    scheduleRender("start", 20, true);
  }
  function resolveSourceAndTarget(a, b) {
    if (a.type === "VECTOR" && b.type !== "VECTOR") return { source: b, target: a };
    if (b.type === "VECTOR" && a.type !== "VECTOR") return { source: a, target: b };
    if (a.type === "VECTOR" && b.type === "VECTOR") {
      return targetPathScore(a) >= targetPathScore(b) ? { source: b, target: a } : { source: a, target: b };
    }
    return null;
  }
  function scheduleRender(reason, delay = 140, force = false) {
    if (!settings.livePreview && !force || !linked) return;
    if (isRendering) {
      pendingRender = true;
      pendingRenderForce = pendingRenderForce || force;
      return;
    }
    if (renderTimer !== void 0) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = void 0;
      void renderLivePreview(reason, force);
    }, delay);
  }
  async function renderLivePreview(_reason, force = false) {
    if (!linked || isRendering || !settings.livePreview && !force) return;
    const activeLink = linked;
    isRendering = true;
    try {
      let source = await figma.getNodeByIdAsync(activeLink.sourceId);
      let target = await figma.getNodeByIdAsync(activeLink.targetId);
      if (!source || !isSceneNode(source) || !target || target.type !== "VECTOR") {
        const outputNode = activeLink.outputId ? await figma.getNodeByIdAsync(activeLink.outputId) : null;
        const embedded = outputNode?.type === "FRAME" ? findEmbeddedOutputParts(outputNode) : null;
        if (embedded) {
          if (!source || !isSceneNode(source)) {
            source = embedded.sourceSnapshot;
            activeLink.sourceId = source.id;
            activeLink.sourceFromOutput = true;
          }
          if (!target || target.type !== "VECTOR") {
            target = embedded.targetGuide;
            activeLink.targetId = target.id;
            activeLink.targetFromOutput = true;
          }
        }
      }
      if (!source || !target || target.type !== "VECTOR" || !isSceneNode(source)) {
        postStatus("Source \u0438\u043B\u0438 path \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B. \u0412\u044B\u0434\u0435\u043B\u0438 \u043F\u0430\u0440\u0443 \u0437\u0430\u043D\u043E\u0432\u043E.", true);
        return;
      }
      const targetCurves = extractTargetCurves(target);
      const rawArcTable = buildArcTable(targetCurves);
      const arcTable = smoothArcTable(rawArcTable, settings.pathSmoothing);
      if (arcTable.totalLength <= EPSILON) {
        postStatus("Target path \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439.", true);
        return;
      }
      const renderKey = buildRenderKey(source.id, target.id, arcTable);
      if (!force && renderKey === lastRenderKey) return;
      lastRenderKey = renderKey;
      const flattened = flattenSourceToVector(source);
      const sourceBounds = boundsFromNetwork(flattened.vectorNetwork);
      if (sourceBounds.width <= EPSILON) {
        flattened.remove();
        throw new Error("Flattened source must have measurable width.");
      }
      const preparedNetwork = subdivideNetworkForWarp(flattened.vectorNetwork, settings.smoothness);
      const warpedPieces = [{
        name: "warped vector",
        network: warpSingle(
          preparedNetwork,
          sourceBounds,
          arcTable,
          settings.thicknessScale,
          settings.patternOffset * arcTable.totalLength,
          arcTable.totalLength,
          true
        )
      }];
      const clipNetwork = buildPathEnvelopeNetwork(arcTable, sourceBounds.height * settings.thicknessScale);
      if (linked !== activeLink) {
        flattened.remove();
        return;
      }
      const output = await createOutputFrame(flattened, source, target, warpedPieces, clipNetwork, 0);
      if (linked !== activeLink) {
        output.frame.remove();
        return;
      }
      activeLink.outputId = output.frame.id;
      activeLink.outputMeta = captureOutputMeta(output.frame);
      activeLink.targetId = output.targetGuide.id;
      activeLink.targetFromOutput = true;
      if (activeLink.sourceFromOutput) activeLink.sourceId = output.sourceSnapshot.id;
      lastRenderKey = buildRenderKey(activeLink.sourceId, activeLink.targetId, arcTable);
      if (arrangeSnapshotsOnNextRender) await arrangeSnapshotsRightOf(output.frame);
      selectEditablePath(output.targetGuide);
      const segmentCount = warpedPieces.reduce((sum, piece) => sum + piece.network.segments.length, 0);
      postStatus(`Preview updated: ${source.name}. Stretch vector. Segments: ${segmentCount}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown live preview error.";
      if (message.toLowerCase().includes("does not exist") || message.toLowerCase().includes("removed")) {
        postStatus("Live preview paused: a linked node is no longer available.", true);
        return;
      }
      postStatus(message, true);
      figma.notify(message, { error: true });
    } finally {
      detachOutputOnNextRender = false;
      arrangeSnapshotsOnNextRender = false;
      isRendering = false;
      if (pendingRender) {
        const rerenderForce = pendingRenderForce;
        pendingRender = false;
        pendingRenderForce = false;
        scheduleRender("pending update", 20, rerenderForce);
      }
    }
  }
  function buildRenderKey(sourceId, targetId, arcTable) {
    return [
      sourceId,
      targetId,
      arcSignature(arcTable),
      settings.thicknessScale,
      settings.patternOffset,
      settings.smoothness,
      settings.pathSmoothing
    ].join("|");
  }
  function flattenSourceToVector(source) {
    const sourceTransform = source.absoluteTransform;
    const clone = source.clone();
    clone.name = `${source.name} - warp source flatten`;
    figma.currentPage.appendChild(clone);
    clone.locked = false;
    clone.visible = true;
    clone.relativeTransform = sourceTransform;
    insertContainerBackgroundIntoClone(clone, source);
    const topLevelOutlines = outlineStrokesBeforeFlatten(clone);
    return figma.flatten([clone, ...topLevelOutlines], figma.currentPage);
  }
  async function createOutputFrame(flattened, source, target, warpedPieces, clipNetwork, skipRegionCount) {
    const previous = linked?.outputId ? await figma.getNodeByIdAsync(linked.outputId) : null;
    const previousScene = previous && isSceneNode(previous) ? previous : null;
    const previousParent = previousScene?.parent && hasChildren(previousScene.parent) ? previousScene.parent : null;
    const previousIndex = previousParent && previousScene ? previousParent.children.indexOf(previousScene) : -1;
    let keepPrevious = false;
    if (previous && "remove" in previous) {
      keepPrevious = detachOutputOnNextRender || previousScene !== null && isOutputTouched(previousScene);
      if (keepPrevious) {
        if (detachOutputOnNextRender && previousScene) rememberAutoArrangeSnapshot(previousScene);
      }
    }
    const networkBounds = boundsFromNetwork(clipNetwork);
    const padding = 2;
    const frameOrigin = { x: networkBounds.minX - padding, y: networkBounds.minY - padding };
    const frameWidth = Math.max(1, networkBounds.width + padding * 2);
    const frameHeight = Math.max(1, networkBounds.height + padding * 2);
    const reuseOutputPlacement = linked?.targetFromOutput === true && previousParent !== null && previousIndex >= 0;
    const parent = reuseOutputPlacement ? previousParent : target.parent && hasChildren(target.parent) ? target.parent : figma.currentPage;
    const targetIndex = reuseOutputPlacement ? previousIndex : parent.children.indexOf(target);
    const frame = figma.createFrame();
    frame.name = `${OUTPUT_NAME_PREFIX} - stretch - ${flattened.name.replace(" - warp source flatten", "")}`;
    frame.clipsContent = true;
    frame.fills = [];
    frame.strokes = [];
    frame.resizeWithoutConstraints(frameWidth, frameHeight);
    frame.relativeTransform = absolutePageTransformForParent(parent, frameOrigin);
    parent.insertChild(Math.min(parent.children.length, targetIndex + 1), frame);
    const sourceSnapshot = cloneSceneNodeIntoParent(source, frame, buildSourceSnapshotName(settings), false, { x: 4, y: 4 });
    const targetGuide = cloneSceneNodeIntoParent(target, frame, OUTPUT_TARGET_NAME, true);
    if (targetGuide.type !== "VECTOR") throw new Error("The embedded editable path must remain a vector node.");
    frame.insertChild(0, targetGuide);
    if (previous && !keepPrevious) previous.remove();
    const parts = buildTileStackedParts(warpedPieces, flattened, skipRegionCount);
    flattened.remove();
    for (const part of parts) {
      const vector = figma.createVector();
      frame.appendChild(vector);
      vector.name = part.name;
      vector.visible = true;
      vector.relativeTransform = [
        [1, 0, 0],
        [0, 1, 0]
      ];
      const localizedNetwork = await normalizeVectorNetworkPaints(translateNetwork(part.network, -frameOrigin.x, -frameOrigin.y));
      await vector.setVectorNetworkAsync(localizedNetwork);
      vector.fills = part.fills ? [...part.fills] : [];
      vector.strokes = part.strokes ? [...part.strokes] : [];
    }
    frame.expanded = true;
    frame.locked = false;
    return { frame, sourceSnapshot, targetGuide };
  }
  function buildTileStackedParts(warpedPieces, flattened, skipRegionCount) {
    return warpedPieces.flatMap((piece, tileIndex) => splitNetworkIntoRegionParts(piece.network, tileIndex, flattened, skipRegionCount));
  }
  function splitNetworkIntoRegionParts(network, tileIndex, flattened, skipRegionCount) {
    const parts = [];
    const usedSegments = /* @__PURE__ */ new Set();
    for (let regionIndex = 0; regionIndex < (network.regions?.length ?? 0); regionIndex += 1) {
      const region = network.regions?.[regionIndex];
      if (!region) continue;
      if (regionIndex < skipRegionCount) continue;
      const segmentIndices = Array.from(new Set(region.loops.flatMap((loop) => [...loop])));
      for (const segmentIndex of segmentIndices) usedSegments.add(segmentIndex);
      const partNetwork = subsetNetworkForRegion(network, region, segmentIndices);
      if (partNetwork.segments.length === 0) continue;
      const regionFills = sanitizePaints(region.fills && region.fills.length > 0 ? region.fills : Array.isArray(flattened.fills) ? flattened.fills : []);
      parts.push({
        tileIndex,
        regionIndex,
        name: `tile ${tileIndex + 1} region ${regionIndex + 1}`,
        network: partNetwork,
        fills: regionFills
      });
    }
    const leftoverSegments = network.segments.map((_, index) => index).filter((index) => !usedSegments.has(index));
    if (leftoverSegments.length > 0) {
      const partNetwork = subsetNetworkForSegments(network, leftoverSegments, []);
      parts.push({
        tileIndex,
        regionIndex: network.regions?.length ?? 0,
        name: `tile ${tileIndex + 1} strokes`,
        network: partNetwork,
        fills: Array.isArray(flattened.fills) ? sanitizePaints(flattened.fills) : [],
        strokes: Array.isArray(flattened.strokes) ? sanitizePaints(flattened.strokes) : []
      });
    }
    return parts;
  }
  function subsetNetworkForRegion(network, region, segmentIndices) {
    const supportedFills = sanitizePaints(region.fills ?? []);
    const remapped = subsetNetworkForSegments(network, segmentIndices, region.loops);
    const remappedRegion = remapped.regions?.[0];
    if (!remappedRegion) return remapped;
    return {
      ...remapped,
      regions: [
        {
          ...remappedRegion,
          ...supportedFills && supportedFills.length > 0 ? { fills: supportedFills } : {}
        }
      ]
    };
  }
  function subsetNetworkForSegments(network, segmentIndices, sourceLoops) {
    const segmentMap = /* @__PURE__ */ new Map();
    const vertexMap = /* @__PURE__ */ new Map();
    const vertices = [];
    const segments = [];
    const mapVertex = (index) => {
      const existing = vertexMap.get(index);
      if (existing !== void 0) return existing;
      const mapped = vertices.length;
      vertices.push({ ...network.vertices[index] });
      vertexMap.set(index, mapped);
      return mapped;
    };
    for (const segmentIndex of segmentIndices) {
      const segment = network.segments[segmentIndex];
      if (!segment) continue;
      segmentMap.set(segmentIndex, segments.length);
      segments.push({
        ...segment,
        start: mapVertex(segment.start),
        end: mapVertex(segment.end)
      });
    }
    const loops = sourceLoops.map((loop) => loop.map((segmentIndex) => segmentMap.get(segmentIndex)).filter((index) => index !== void 0)).filter((loop) => loop.length > 0);
    return {
      vertices,
      segments,
      regions: loops.length > 0 ? [{ windingRule: "NONZERO", loops }] : []
    };
  }
  function insertContainerBackgroundIntoClone(clone, source) {
    if (!hasChildren(clone) || !("fills" in source) || !("width" in source) || !("height" in source)) return;
    if (!Array.isArray(source.fills) || source.fills.length === 0) return;
    if (source.fills.every((fill) => fill.visible === false)) return;
    const background = figma.createRectangle();
    background.name = `${source.name} - flatten background`;
    background.resizeWithoutConstraints(source.width, source.height);
    background.fills = source.fills;
    background.strokes = [];
    background.relativeTransform = [
      [1, 0, 0],
      [0, 1, 0]
    ];
    try {
      clone.insertChild(0, background);
    } catch {
      background.remove();
    }
  }
  function outlineStrokesBeforeFlatten(root) {
    const topLevelOutlines = [];
    const visit = (node) => {
      const children = hasChildren(node) ? [...node.children].filter(isSceneNode) : [];
      for (const child of children) visit(child);
      const outline = createStrokeOutlineSibling(node);
      if (!outline) return;
      if (node === root) {
        topLevelOutlines.push(outline);
        return;
      }
      const parent = node.parent;
      if (parent && hasChildren(parent)) {
        const insertIndex = Math.min(parent.children.length, parent.children.indexOf(node) + 1);
        parent.insertChild(insertIndex, outline);
      } else {
        topLevelOutlines.push(outline);
      }
    };
    visit(root);
    return topLevelOutlines;
  }
  function createStrokeOutlineSibling(node) {
    if (!hasOutlineableStroke(node)) return null;
    const strokeFills = sanitizePaints(node.strokes.filter((paint) => paint.visible !== false));
    if (strokeFills.length === 0) return null;
    const parent = node.parent;
    const outline = node.outlineStroke();
    if (!outline) return null;
    outline.name = `${node.name} - outlined stroke`;
    if (Array.isArray(outline.fills)) outline.fills = sanitizePaints(outline.fills);
    outline.strokes = [];
    node.strokes = [];
    if (parent && hasChildren(parent)) {
      const insertIndex = Math.min(parent.children.length, parent.children.indexOf(node) + 1);
      parent.insertChild(insertIndex, outline);
    }
    return outline;
  }
  function hasOutlineableStroke(node) {
    return "strokes" in node && "outlineStroke" in node;
  }
  function buildPathEnvelopeNetwork(arcTable, height) {
    const sampleCount = Math.max(24, Math.ceil(arcTable.totalLength / 12));
    const halfHeight = height / 2;
    const top = [];
    const bottom = [];
    for (let index = 0; index <= sampleCount; index += 1) {
      const sample = evaluateAtLength(arcTable, arcTable.totalLength * index / sampleCount);
      const normal = { x: -sample.tangent.y, y: sample.tangent.x };
      top.push({
        x: sample.point.x + normal.x * halfHeight,
        y: sample.point.y + normal.y * halfHeight
      });
      bottom.push({
        x: sample.point.x - normal.x * halfHeight,
        y: sample.point.y - normal.y * halfHeight
      });
    }
    const vertices = [...top, ...bottom.reverse()];
    const segments = [];
    for (let index = 0; index < vertices.length; index += 1) {
      segments.push({ start: index, end: (index + 1) % vertices.length });
    }
    return {
      vertices,
      segments,
      regions: [
        {
          windingRule: "NONZERO",
          loops: [segments.map((_, index) => index)]
        }
      ]
    };
  }
  async function normalizeVectorNetworkPaints(network) {
    const regions = [];
    for (const region of network.regions ?? []) {
      const fills = region.fills ? await normalizePaints(region.fills) : region.fills;
      regions.push({ ...region, fills });
    }
    return { ...network, regions };
  }
  async function normalizePaints(paints) {
    return sanitizePaints(paints);
  }
  function sanitizePaints(paints) {
    return paints.filter(isSettablePaint);
  }
  function isSettablePaint(paint) {
    return paint.type !== "PATTERN";
  }
  function hasChildren(node) {
    return "children" in node && "insertChild" in node;
  }
  function captureOutputMeta(node) {
    const bounds = node.absoluteBoundingBox;
    if (!bounds || !node.parent) return void 0;
    return {
      id: node.id,
      name: node.name,
      parentId: node.parent.id,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  }
  function isOutputTouched(node) {
    const meta = linked?.outputMeta;
    const bounds = node.absoluteBoundingBox;
    if (!meta || !bounds || !node.parent) return false;
    return node.name !== meta.name || node.parent.id !== meta.parentId || Math.abs(bounds.x - meta.x) > 0.5 || Math.abs(bounds.y - meta.y) > 0.5 || Math.abs(bounds.width - meta.width) > 0.5 || Math.abs(bounds.height - meta.height) > 0.5;
  }
  function rememberAutoArrangeSnapshot(node) {
    autoArrangeSnapshotIds = [node.id, ...autoArrangeSnapshotIds.filter((id) => id !== node.id)];
  }
  async function arrangeSnapshotsRightOf(activeFrame) {
    const activeBounds = activeFrame.absoluteBoundingBox;
    if (!activeBounds) return;
    let cursorX = activeBounds.x + activeBounds.width + SNAPSHOT_GAP;
    const y = activeBounds.y;
    const existingIds = [];
    for (const snapshotId of autoArrangeSnapshotIds) {
      const node = await figma.getNodeByIdAsync(snapshotId);
      if (!node || !isSceneNode(node) || !node.parent || !hasChildren(node.parent)) continue;
      const bounds = node.absoluteBoundingBox;
      if (!bounds) continue;
      node.relativeTransform = absolutePageTransformForParent(node.parent, { x: cursorX, y });
      cursorX += bounds.width + SNAPSHOT_GAP;
      existingIds.push(snapshotId);
    }
    autoArrangeSnapshotIds = existingIds;
  }
  function absolutePageTransformForParent(parent, pageOrigin) {
    if (parent.type === "PAGE") {
      return [
        [1, 0, pageOrigin.x],
        [0, 1, pageOrigin.y]
      ];
    }
    const inverse = invertTransform(parent.absoluteTransform);
    return multiplyTransform(inverse, [
      [1, 0, pageOrigin.x],
      [0, 1, pageOrigin.y]
    ]);
  }
  function relativeTransformForParent(parent, absoluteTransform) {
    if (parent.type === "PAGE") return absoluteTransform;
    return multiplyTransform(invertTransform(parent.absoluteTransform), absoluteTransform);
  }
  function cloneSceneNodeIntoParent(source, parent, name, visible, localOrigin) {
    const sourceTransform = source.absoluteTransform;
    const clone = source.clone();
    parent.appendChild(clone);
    clone.locked = false;
    const relativeTransform = relativeTransformForParent(parent, sourceTransform);
    if (localOrigin) {
      relativeTransform[0][2] = localOrigin.x;
      relativeTransform[1][2] = localOrigin.y;
    }
    clone.relativeTransform = relativeTransform;
    clone.name = name;
    clone.visible = visible;
    return clone;
  }
  function selectEditablePath(path) {
    figma.currentPage.selection = [path];
  }
  function translateNetwork(network, dx, dy) {
    return {
      vertices: network.vertices.map((vertex) => ({ ...vertex, x: vertex.x + dx, y: vertex.y + dy })),
      segments: network.segments.map((segment) => ({ ...segment })),
      regions: network.regions ? network.regions.map(copyRegion) : []
    };
  }
  function boundsFromNetwork(network) {
    const points = [];
    for (const vertex of network.vertices) {
      points.push({ x: vertex.x, y: vertex.y });
    }
    for (const segment of network.segments) {
      const start = network.vertices[segment.start];
      const end = network.vertices[segment.end];
      if (!start || !end) continue;
      points.push({
        x: start.x + (segment.tangentStart?.x ?? 0),
        y: start.y + (segment.tangentStart?.y ?? 0)
      });
      points.push({
        x: end.x + (segment.tangentEnd?.x ?? 0),
        y: end.y + (segment.tangentEnd?.y ?? 0)
      });
    }
    if (points.length === 0) throw new Error("Vector has no vertices.");
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }
  function subdivideNetworkForWarp(network, smoothness) {
    const quality = Math.max(1, Math.min(12, Math.round(smoothness)));
    const maxSourceXStep = 32 / quality;
    const maxPiecesPerSegment = quality * 12;
    const vertices = network.vertices.map((vertex) => ({ ...vertex }));
    const segments = [];
    const segmentMap = /* @__PURE__ */ new Map();
    network.segments.forEach((segment, segmentIndex) => {
      const cubic = sourceSegmentToCubic(network, segment);
      const piecesCount = sourceSubdivisionCount(cubic, maxSourceXStep, maxPiecesPerSegment);
      const mappedSegmentIndices = [];
      if (piecesCount <= 1) {
        mappedSegmentIndices.push(segments.length);
        segments.push({ ...segment });
        segmentMap.set(segmentIndex, mappedSegmentIndices);
        return;
      }
      const pieces = splitCubicIntoEqualPieces(cubic, piecesCount);
      let currentStart = segment.start;
      pieces.forEach((piece, pieceIndex) => {
        const currentEnd = pieceIndex === pieces.length - 1 ? segment.end : addSubdivisionVertex(vertices, network.vertices[segment.start], network.vertices[segment.end], piece.p3, pieceIndex / pieces.length);
        mappedSegmentIndices.push(segments.length);
        segments.push({
          ...segment,
          start: currentStart,
          end: currentEnd,
          tangentStart: subtract(piece.p1, piece.p0),
          tangentEnd: subtract(piece.p2, piece.p3)
        });
        currentStart = currentEnd;
      });
      segmentMap.set(segmentIndex, mappedSegmentIndices);
    });
    const regions = (network.regions ?? []).map((region) => ({
      ...region,
      loops: region.loops.map(
        (loop) => orientLoop(network, loop).flatMap((item) => {
          const mapped = segmentMap.get(item.segmentIndex) ?? [];
          return item.reversed ? [...mapped].reverse() : mapped;
        })
      )
    }));
    return { vertices, segments, regions };
  }
  function sourceSubdivisionCount(cubic, maxSourceXStep, maxPiecesPerSegment) {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    for (let index = 0; index <= 12; index += 1) {
      const point = cubicPoint(cubic, index / 12);
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
    }
    return Math.max(1, Math.min(maxPiecesPerSegment, Math.ceil((maxX - minX) / maxSourceXStep)));
  }
  function addSubdivisionVertex(vertices, start, end, point, t) {
    const strokeCap = start.strokeCap !== void 0 && start.strokeCap === end.strokeCap ? start.strokeCap : void 0;
    const strokeJoin = start.strokeJoin !== void 0 && start.strokeJoin === end.strokeJoin ? start.strokeJoin : void 0;
    const cornerRadius = start.cornerRadius !== void 0 || end.cornerRadius !== void 0 ? lerp(start.cornerRadius ?? 0, end.cornerRadius ?? 0, t) : void 0;
    vertices.push({
      x: point.x,
      y: point.y,
      ...strokeCap !== void 0 ? { strokeCap } : {},
      ...strokeJoin !== void 0 ? { strokeJoin } : {},
      ...cornerRadius !== void 0 ? { cornerRadius } : {}
    });
    return vertices.length - 1;
  }
  function warpSingle(network, bounds, arcTable, thicknessScale, arcStart, arcSpan, extendBeyondPath) {
    const baselineY = bounds.minY + bounds.height / 2;
    const vertices = network.vertices.map((vertex) => {
      const warped = warpPoint({ x: vertex.x, y: vertex.y }, bounds, baselineY, arcTable, thicknessScale, arcStart, arcSpan, extendBeyondPath);
      return { ...vertex, x: warped.x, y: warped.y };
    });
    const segments = network.segments.map((segment) => {
      const sourceStart = network.vertices[segment.start];
      const sourceEnd = network.vertices[segment.end];
      const warpedStart = vertices[segment.start];
      const warpedEnd = vertices[segment.end];
      const tangentStartPoint = {
        x: sourceStart.x + (segment.tangentStart?.x ?? 0),
        y: sourceStart.y + (segment.tangentStart?.y ?? 0)
      };
      const tangentEndPoint = {
        x: sourceEnd.x + (segment.tangentEnd?.x ?? 0),
        y: sourceEnd.y + (segment.tangentEnd?.y ?? 0)
      };
      const warpedTangentStart = warpPoint(tangentStartPoint, bounds, baselineY, arcTable, thicknessScale, arcStart, arcSpan, extendBeyondPath);
      const warpedTangentEnd = warpPoint(tangentEndPoint, bounds, baselineY, arcTable, thicknessScale, arcStart, arcSpan, extendBeyondPath);
      return {
        ...segment,
        tangentStart: { x: warpedTangentStart.x - warpedStart.x, y: warpedTangentStart.y - warpedStart.y },
        tangentEnd: { x: warpedTangentEnd.x - warpedEnd.x, y: warpedTangentEnd.y - warpedEnd.y }
      };
    });
    return { vertices, segments, regions: network.regions ? network.regions.map(copyRegion) : [] };
  }
  function warpPoint(point, bounds, baselineY, arcTable, thicknessScale, arcStart, arcSpan, extendBeyondPath) {
    const u = (point.x - bounds.minX) / bounds.width;
    const sample = extendBeyondPath ? evaluateAtLengthExtended(arcTable, arcStart + u * arcSpan) : evaluateAtLength(arcTable, arcStart + u * arcSpan);
    const normal = { x: -sample.tangent.y, y: sample.tangent.x };
    const offset = (point.y - baselineY) * thicknessScale;
    return { x: sample.point.x + normal.x * offset, y: sample.point.y + normal.y * offset };
  }
  function extractTargetCurves(node, throwOnEmpty = true) {
    const network = node.vectorNetwork;
    const pageVertices = network.vertices.map((vertex) => transformPoint(node.absoluteTransform, vertex));
    const segmentToCubic = (segmentIndex, reversed) => {
      const segment = network.segments[segmentIndex];
      if (!segment) return null;
      const startIndex = reversed ? segment.end : segment.start;
      const endIndex = reversed ? segment.start : segment.end;
      const start = network.vertices[startIndex];
      const end = network.vertices[endIndex];
      if (!start || !end) return null;
      const startTangent = reversed ? segment.tangentEnd : segment.tangentStart;
      const endTangent = reversed ? segment.tangentStart : segment.tangentEnd;
      return {
        curve: {
          p0: pageVertices[startIndex],
          p1: transformPoint(node.absoluteTransform, { x: start.x + (startTangent?.x ?? 0), y: start.y + (startTangent?.y ?? 0) }),
          p2: transformPoint(node.absoluteTransform, { x: end.x + (endTangent?.x ?? 0), y: end.y + (endTangent?.y ?? 0) }),
          p3: pageVertices[endIndex]
        },
        startVertex: startIndex,
        endVertex: endIndex
      };
    };
    const chains = orderedOpenChains(network);
    const ordered = chains.map((chain) => chain.map((item) => segmentToCubic(item.segmentIndex, item.reversed)).filter((part) => part !== null)).filter((chain) => chain.length > 0);
    const longest = ordered.sort((a, b) => chainLength(b.map((part) => part.curve)) - chainLength(a.map((part) => part.curve)))[0];
    if (!longest && throwOnEmpty) throw new Error("Target vector does not contain a usable continuous path.");
    return longest ? roundTargetCorners(longest, network, node.absoluteTransform) : [];
  }
  function roundTargetCorners(parts, network, transform) {
    if (parts.length === 0) return [];
    const startTrim = parts.map(() => 0);
    const endTrim = parts.map(() => 1);
    const corners = /* @__PURE__ */ new Map();
    const closed = parts.length > 1 && parts[0].startVertex === parts[parts.length - 1].endVertex;
    const radiusScale = transformScale(transform);
    for (let index = 0; index < parts.length; index += 1) {
      const nextIndex = index + 1 < parts.length ? index + 1 : closed ? 0 : -1;
      if (nextIndex < 0 || nextIndex === index) continue;
      const incoming = parts[index];
      const outgoing = parts[nextIndex];
      if (incoming.endVertex !== outgoing.startVertex) continue;
      const vertex = network.vertices[incoming.endVertex];
      const localRadius = vertex?.cornerRadius ?? 0;
      if (localRadius <= EPSILON) continue;
      const incomingLength = approximateCubicLength(incoming.curve, 24);
      const outgoingLength = approximateCubicLength(outgoing.curve, 24);
      if (incomingLength <= EPSILON || outgoingLength <= EPSILON) continue;
      const arrive = normalize(subtract(incoming.curve.p3, incoming.curve.p2), fallbackTangent(incoming.curve));
      const leave = normalize(subtract(outgoing.curve.p1, outgoing.curve.p0), fallbackTangent(outgoing.curve));
      const fromVertexToPrevious = { x: -arrive.x, y: -arrive.y };
      const interiorAngle = Math.acos(clamp(dot(fromVertexToPrevious, leave), -1, 1));
      if (interiorAngle <= 0.04 || Math.abs(Math.PI - interiorAngle) <= 0.04) continue;
      const tangentDistance = radiusScale * localRadius / Math.max(EPSILON, Math.tan(interiorAngle / 2));
      const maxTrim = Math.min(incomingLength, outgoingLength) * 0.45;
      const trimDistance = Math.min(tangentDistance, maxTrim);
      if (trimDistance <= EPSILON) continue;
      const incomingT = cubicParameterAtLength(incoming.curve, incomingLength - trimDistance);
      const outgoingT = cubicParameterAtLength(outgoing.curve, trimDistance);
      if (incomingT <= EPSILON || outgoingT >= 1 - EPSILON) continue;
      const arrivalAtTrim = normalize(cubicDerivative(incoming.curve, incomingT), arrive);
      const leaveAtTrim = normalize(cubicDerivative(outgoing.curve, outgoingT), leave);
      const start = cubicPoint(incoming.curve, incomingT);
      const end = cubicPoint(outgoing.curve, outgoingT);
      const effectiveRadius = trimDistance * Math.tan(interiorAngle / 2);
      const turnAngle = Math.PI - interiorAngle;
      const handleLength = 4 / 3 * Math.tan(turnAngle / 4) * effectiveRadius;
      endTrim[index] = incomingT;
      startTrim[nextIndex] = outgoingT;
      corners.set(index, {
        p0: start,
        p1: { x: start.x + arrivalAtTrim.x * handleLength, y: start.y + arrivalAtTrim.y * handleLength },
        p2: { x: end.x - leaveAtTrim.x * handleLength, y: end.y - leaveAtTrim.y * handleLength },
        p3: end
      });
    }
    const curves = [];
    for (let index = 0; index < parts.length; index += 1) {
      const trimmed = trimCubic(parts[index].curve, startTrim[index], endTrim[index]);
      if (trimmed && approximateCubicLength(trimmed, 8) > EPSILON) curves.push(trimmed);
      const corner = corners.get(index);
      if (corner && approximateCubicLength(corner, 8) > EPSILON) curves.push(corner);
    }
    return curves;
  }
  function orderedOpenChains(network) {
    const adjacency = /* @__PURE__ */ new Map();
    network.segments.forEach((segment, index) => {
      adjacency.set(segment.start, [...adjacency.get(segment.start) ?? [], index]);
      adjacency.set(segment.end, [...adjacency.get(segment.end) ?? [], index]);
    });
    const unused = new Set(network.segments.map((_, index) => index));
    const chains = [];
    while (unused.size > 0) {
      const seed = unused.values().next().value;
      if (seed === void 0) break;
      const component = collectComponent(network, seed, adjacency);
      const endpoints = Array.from(component.vertices).filter((vertex) => (adjacency.get(vertex) ?? []).filter((index) => component.segments.has(index)).length === 1);
      let cursor = endpoints[0] ?? component.vertices.values().next().value;
      const chain = [];
      while (cursor !== void 0) {
        const next = (adjacency.get(cursor) ?? []).find((index) => unused.has(index) && component.segments.has(index));
        if (next === void 0) break;
        const segment = network.segments[next];
        const reversed = segment.end === cursor;
        chain.push({ segmentIndex: next, reversed });
        unused.delete(next);
        cursor = reversed ? segment.start : segment.end;
      }
      for (const segmentIndex of component.segments) {
        if (unused.has(segmentIndex)) {
          chain.push({ segmentIndex, reversed: false });
          unused.delete(segmentIndex);
        }
      }
      chains.push(chain);
    }
    return chains;
  }
  function collectComponent(network, startSegmentIndex, adjacency) {
    const segments = /* @__PURE__ */ new Set();
    const vertices = /* @__PURE__ */ new Set();
    const queue = [startSegmentIndex];
    while (queue.length > 0) {
      const segmentIndex = queue.shift();
      if (segmentIndex === void 0 || segments.has(segmentIndex)) continue;
      const segment = network.segments[segmentIndex];
      segments.add(segmentIndex);
      vertices.add(segment.start);
      vertices.add(segment.end);
      for (const vertex of [segment.start, segment.end]) {
        for (const next of adjacency.get(vertex) ?? []) {
          if (!segments.has(next)) queue.push(next);
        }
      }
    }
    return { segments, vertices };
  }
  function orientLoop(network, loop) {
    const tryOrient = (firstReversed) => {
      if (loop.length === 0) return [];
      const result = [{ segmentIndex: loop[0], reversed: firstReversed }];
      let cursor = firstReversed ? network.segments[loop[0]]?.start : network.segments[loop[0]]?.end;
      if (cursor === void 0) return result;
      for (const segmentIndex of loop.slice(1)) {
        const segment = network.segments[segmentIndex];
        if (!segment) continue;
        if (segment.start === cursor) {
          result.push({ segmentIndex, reversed: false });
          cursor = segment.end;
        } else if (segment.end === cursor) {
          result.push({ segmentIndex, reversed: true });
          cursor = segment.start;
        } else {
          return result;
        }
      }
      return result;
    };
    const forward = tryOrient(false);
    const reversed = tryOrient(true);
    return reversed.length > forward.length ? reversed : forward;
  }
  function smoothArcTable(arcTable, smoothing) {
    const level = Math.max(0, Math.min(10, Math.round(smoothing)));
    if (level === 0 || arcTable.totalLength <= EPSILON) return arcTable;
    const sampleSpacing = Math.max(4, 9 - level * 0.35);
    const sampleCount = Math.max(8, Math.min(1200, Math.ceil(arcTable.totalLength / sampleSpacing)));
    let points = [];
    for (let index = 0; index <= sampleCount; index += 1) {
      points.push(evaluateAtLength(arcTable, arcTable.totalLength * index / sampleCount).point);
    }
    const radius = Math.max(1, Math.ceil(level / 2));
    const strength = Math.min(0.85, 0.22 + level * 0.065);
    const iterations = Math.max(1, Math.ceil(level / 2));
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      points = smoothPointPass(points, radius, strength);
    }
    const curves = catmullRomToCubics(removeNearDuplicatePoints(points, 0.5));
    if (curves.length === 0) return arcTable;
    const smoothed = buildArcTable(curves);
    return smoothed.totalLength > EPSILON ? smoothed : arcTable;
  }
  function smoothPointPass(points, radius, strength) {
    if (points.length <= 2) return points;
    return points.map((point, index) => {
      if (index === 0 || index === points.length - 1) return point;
      let totalWeight = 0;
      let x = 0;
      let y = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const neighborIndex = Math.max(0, Math.min(points.length - 1, index + offset));
        const weight = radius + 1 - Math.abs(offset);
        totalWeight += weight;
        x += points[neighborIndex].x * weight;
        y += points[neighborIndex].y * weight;
      }
      const average = { x: x / totalWeight, y: y / totalWeight };
      return mixPoint(point, average, strength);
    });
  }
  function removeNearDuplicatePoints(points, minDistance) {
    const filtered = [];
    for (const point of points) {
      const previous = filtered[filtered.length - 1];
      if (!previous || distance(previous, point) >= minDistance) filtered.push(point);
    }
    return filtered.length >= 2 ? filtered : points;
  }
  function catmullRomToCubics(points) {
    const curves = [];
    if (points.length < 2) return curves;
    for (let index = 0; index < points.length - 1; index += 1) {
      const previous = points[Math.max(0, index - 1)];
      const start = points[index];
      const end = points[index + 1];
      const next = points[Math.min(points.length - 1, index + 2)];
      if (distance(start, end) <= EPSILON) continue;
      curves.push({
        p0: start,
        p1: {
          x: start.x + (end.x - previous.x) / 6,
          y: start.y + (end.y - previous.y) / 6
        },
        p2: {
          x: end.x - (next.x - start.x) / 6,
          y: end.y - (next.y - start.y) / 6
        },
        p3: end
      });
    }
    return curves;
  }
  function buildArcTable(curves) {
    const samples = [{ curveIndex: 0, t: 0, length: 0 }];
    let totalLength = 0;
    curves.forEach((curve, curveIndex) => {
      const roughLength = approximateCubicLength(curve, 12);
      const steps = Math.max(12, Math.min(220, Math.ceil(roughLength / TARGET_SAMPLE_PX)));
      let previous = cubicPoint(curve, 0);
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const current = cubicPoint(curve, t);
        totalLength += distance(previous, current);
        samples.push({ curveIndex, t, length: totalLength });
        previous = current;
      }
    });
    return { curves, samples, totalLength };
  }
  function evaluateAtLength(arcTable, requestedLength) {
    const length = Math.max(0, Math.min(arcTable.totalLength, requestedLength));
    const samples = arcTable.samples;
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (samples[mid].length < length) lo = mid + 1;
      else hi = mid;
    }
    const upper = samples[lo];
    const lower = samples[Math.max(0, lo - 1)];
    const span = Math.max(EPSILON, upper.length - lower.length);
    const alpha = (length - lower.length) / span;
    const curveIndex = upper.curveIndex;
    const t = lower.curveIndex === upper.curveIndex ? lerp(lower.t, upper.t, alpha) : upper.t;
    const curve = arcTable.curves[curveIndex];
    return { point: cubicPoint(curve, t), tangent: normalize(cubicDerivative(curve, t), fallbackTangent(curve)) };
  }
  function evaluateAtLengthExtended(arcTable, requestedLength) {
    if (requestedLength < 0) {
      const start = evaluateAtLength(arcTable, 0);
      return {
        point: {
          x: start.point.x + start.tangent.x * requestedLength,
          y: start.point.y + start.tangent.y * requestedLength
        },
        tangent: start.tangent
      };
    }
    if (requestedLength > arcTable.totalLength) {
      const end = evaluateAtLength(arcTable, arcTable.totalLength);
      const overshoot = requestedLength - arcTable.totalLength;
      return {
        point: {
          x: end.point.x + end.tangent.x * overshoot,
          y: end.point.y + end.tangent.y * overshoot
        },
        tangent: end.tangent
      };
    }
    return evaluateAtLength(arcTable, requestedLength);
  }
  function arcSignature(arcTable) {
    const parts = [Math.round(arcTable.totalLength).toString()];
    for (let index = 0; index <= 10; index += 1) {
      const sample = evaluateAtLength(arcTable, arcTable.totalLength * index / 10);
      parts.push(`${Math.round(sample.point.x)},${Math.round(sample.point.y)},${Math.round(sample.tangent.x * 100)},${Math.round(sample.tangent.y * 100)}`);
    }
    return parts.join(";");
  }
  function sourceSegmentToCubic(network, segment) {
    const start = network.vertices[segment.start];
    const end = network.vertices[segment.end];
    return {
      p0: { x: start.x, y: start.y },
      p1: { x: start.x + (segment.tangentStart?.x ?? 0), y: start.y + (segment.tangentStart?.y ?? 0) },
      p2: { x: end.x + (segment.tangentEnd?.x ?? 0), y: end.y + (segment.tangentEnd?.y ?? 0) },
      p3: { x: end.x, y: end.y }
    };
  }
  function splitCubicIntoEqualPieces(cubic, count) {
    const pieces = [];
    let remainder = cubic;
    for (let index = 0; index < count - 1; index += 1) {
      const split = splitCubic(remainder, 1 / (count - index));
      pieces.push(split.left);
      remainder = split.right;
    }
    pieces.push(remainder);
    return pieces;
  }
  function splitCubic(cubic, t) {
    const clamped = clamp(t, 0, 1);
    const p01 = mixPoint(cubic.p0, cubic.p1, clamped);
    const p12 = mixPoint(cubic.p1, cubic.p2, clamped);
    const p23 = mixPoint(cubic.p2, cubic.p3, clamped);
    const p012 = mixPoint(p01, p12, clamped);
    const p123 = mixPoint(p12, p23, clamped);
    const p0123 = mixPoint(p012, p123, clamped);
    return {
      left: { p0: cubic.p0, p1: p01, p2: p012, p3: p0123 },
      right: { p0: p0123, p1: p123, p2: p23, p3: cubic.p3 }
    };
  }
  function trimCubic(cubic, startT, endT) {
    const start = clamp(startT, 0, 1);
    const end = clamp(endT, 0, 1);
    if (end - start <= EPSILON) return null;
    if (start <= EPSILON && end >= 1 - EPSILON) return cubic;
    let remainder = cubic;
    if (start > EPSILON) remainder = splitCubic(remainder, start).right;
    if (end >= 1 - EPSILON) return remainder;
    const span = Math.max(EPSILON, 1 - start);
    return splitCubic(remainder, (end - start) / span).left;
  }
  function cubicParameterAtLength(curve, requestedLength) {
    const totalLength = approximateCubicLength(curve, 32);
    if (totalLength <= EPSILON) return 0;
    const targetLength = clamp(requestedLength, 0, totalLength);
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const middle = (low + high) / 2;
      const beforeMiddle = approximateCubicLength(splitCubic(curve, middle).left, 12);
      if (beforeMiddle < targetLength) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  }
  function cubicPoint(curve, t) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    return {
      x: mt2 * mt * curve.p0.x + 3 * mt2 * t * curve.p1.x + 3 * mt * t2 * curve.p2.x + t2 * t * curve.p3.x,
      y: mt2 * mt * curve.p0.y + 3 * mt2 * t * curve.p1.y + 3 * mt * t2 * curve.p2.y + t2 * t * curve.p3.y
    };
  }
  function cubicDerivative(curve, t) {
    const mt = 1 - t;
    return {
      x: 3 * mt * mt * (curve.p1.x - curve.p0.x) + 6 * mt * t * (curve.p2.x - curve.p1.x) + 3 * t * t * (curve.p3.x - curve.p2.x),
      y: 3 * mt * mt * (curve.p1.y - curve.p0.y) + 6 * mt * t * (curve.p2.y - curve.p1.y) + 3 * t * t * (curve.p3.y - curve.p2.y)
    };
  }
  function approximateCubicLength(curve, steps) {
    let length = 0;
    let previous = cubicPoint(curve, 0);
    for (let index = 1; index <= steps; index += 1) {
      const current = cubicPoint(curve, index / steps);
      length += distance(previous, current);
      previous = current;
    }
    return length;
  }
  function chainLength(curves) {
    return curves.reduce((sum, curve) => sum + approximateCubicLength(curve, 12), 0);
  }
  function transformPoint(transform, point) {
    return {
      x: transform[0][0] * point.x + transform[0][1] * point.y + transform[0][2],
      y: transform[1][0] * point.x + transform[1][1] * point.y + transform[1][2]
    };
  }
  function transformScale(transform) {
    const xAxisScale = Math.hypot(transform[0][0], transform[1][0]);
    const yAxisScale = Math.hypot(transform[0][1], transform[1][1]);
    return Math.max(EPSILON, (xAxisScale + yAxisScale) / 2);
  }
  function invertTransform(transform) {
    const [[a, c, e], [b, d, f]] = transform;
    const determinant = a * d - b * c;
    if (Math.abs(determinant) <= EPSILON) {
      return [
        [1, 0, 0],
        [0, 1, 0]
      ];
    }
    const invA = d / determinant;
    const invB = -b / determinant;
    const invC = -c / determinant;
    const invD = a / determinant;
    return [
      [invA, invC, -(invA * e + invC * f)],
      [invB, invD, -(invB * e + invD * f)]
    ];
  }
  function multiplyTransform(a, b) {
    return [
      [
        a[0][0] * b[0][0] + a[0][1] * b[1][0],
        a[0][0] * b[0][1] + a[0][1] * b[1][1],
        a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]
      ],
      [
        a[1][0] * b[0][0] + a[1][1] * b[1][0],
        a[1][0] * b[0][1] + a[1][1] * b[1][1],
        a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]
      ]
    ];
  }
  function normalize(vector, fallback) {
    const length = Math.hypot(vector.x, vector.y);
    if (length <= EPSILON) return fallback;
    return { x: vector.x / length, y: vector.y / length };
  }
  function dot(a, b) {
    return a.x * b.x + a.y * b.y;
  }
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function fallbackTangent(curve) {
    return normalize({ x: curve.p3.x - curve.p0.x, y: curve.p3.y - curve.p0.y }, { x: 1, y: 0 });
  }
  function mixPoint(a, b, t) {
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  }
  function subtract(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
  }
  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function copyRegion(region) {
    return { ...region, loops: region.loops.map((loop) => [...loop]) };
  }
  function isSceneNode(node) {
    return "visible" in node && "absoluteTransform" in node;
  }
  function isCurrentOutput(node) {
    return linked?.outputId === node.id;
  }
  function buildSourceSnapshotName(currentSettings) {
    return [
      OUTPUT_SOURCE_NAME,
      "v=1",
      `live=${currentSettings.livePreview ? 1 : 0}`,
      `thickness=${currentSettings.thicknessScale.toFixed(4)}`,
      `offset=${currentSettings.patternOffset.toFixed(4)}`,
      `path=${Math.round(currentSettings.pathSmoothing)}`
    ].join("|");
  }
  function parseSourceSnapshotSettings(name) {
    const prefix = `${OUTPUT_SOURCE_NAME}|`;
    if (!name.startsWith(prefix)) return null;
    const values = {};
    for (const item of name.slice(prefix.length).split("|")) {
      const separator = item.indexOf("=");
      if (separator <= 0) continue;
      values[item.slice(0, separator)] = item.slice(separator + 1);
    }
    const thicknessScale = Number(values.thickness);
    const patternOffset = Number(values.offset);
    const pathSmoothing = Number(values.path);
    if (!Number.isFinite(thicknessScale) || !Number.isFinite(patternOffset) || !Number.isFinite(pathSmoothing)) return null;
    return {
      livePreview: values.live === "1",
      thicknessScale: clamp(thicknessScale, 0.1, 3),
      patternOffset: clamp(patternOffset, -1, 1),
      pathSmoothing: clamp(Math.round(pathSmoothing), 0, 10)
    };
  }
  function postSettingsToUi() {
    figma.ui.postMessage({
      type: "settings",
      settings: {
        livePreview: settings.livePreview,
        thicknessScale: settings.thicknessScale,
        patternOffset: settings.patternOffset,
        pathSmoothing: settings.pathSmoothing
      }
    });
  }
  function findEmbeddedOutputParts(frame) {
    if (!frame.name.startsWith(OUTPUT_NAME_PREFIX)) return null;
    const namedTarget = frame.children.find((child) => child.type === "VECTOR" && child.name === OUTPUT_TARGET_NAME);
    const firstChild = frame.children[0];
    const targetGuide = namedTarget ?? (firstChild?.type === "VECTOR" ? firstChild : null);
    const namedSource = frame.children.find((child) => child.name.startsWith(OUTPUT_SOURCE_NAME) && isSceneNode(child));
    const sourceSnapshot = namedSource ?? frame.children.find((child) => isSceneNode(child) && child !== targetGuide && child.visible === false) ?? null;
    if (!sourceSnapshot || !targetGuide) return null;
    return { sourceSnapshot, targetGuide, persistedSettings: parseSourceSnapshotSettings(sourceSnapshot.name) };
  }
  function findOutputFrameForNode(node) {
    let current = node;
    while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
      if (current.type === "FRAME" && findEmbeddedOutputParts(current)) return current;
      current = current.parent;
    }
    return null;
  }
  function getSelectedOutputFrame() {
    const selection = figma.currentPage.selection;
    return selection.length === 1 ? findOutputFrameForNode(selection[0]) : null;
  }
  function restoreLinkedOutputFromSelection() {
    const frame = getSelectedOutputFrame();
    if (!frame) return false;
    const embedded = findEmbeddedOutputParts(frame);
    if (!embedded) return false;
    const alreadyLinked = linked?.outputId === frame.id && linked.targetId === embedded.targetGuide.id;
    if (alreadyLinked) return false;
    if (embedded.persistedSettings) {
      settings = {
        ...settings,
        ...embedded.persistedSettings,
        smoothness: DEFAULT_SOURCE_SMOOTHNESS
      };
      postSettingsToUi();
    }
    linked = {
      sourceId: embedded.sourceSnapshot.id,
      targetId: embedded.targetGuide.id,
      outputId: frame.id,
      outputMeta: captureOutputMeta(frame),
      sourceFromOutput: true,
      targetFromOutput: true
    };
    detachOutputOnNextRender = false;
    arrangeSnapshotsOnNextRender = false;
    lastRenderKey = "";
    return true;
  }
  function postSelectionStatus() {
    const rawSelection = figma.currentPage.selection;
    if (rawSelection.length === 1 && findOutputFrameForNode(rawSelection[0])) {
      figma.ui.postMessage({ type: "selection", state: "ready", message: "Live frame selected \u2014 path editing is ready." });
      return;
    }
    const selection = rawSelection.filter((node) => !isCurrentOutput(node));
    let state = "none";
    let message = "Select a source and a vector path.";
    if (selection.length === 1) {
      const selected = selection[0];
      if (findOutputFrameForNode(selected)) {
        state = "ready";
        message = "Live frame selected \u2014 path editing is ready.";
      } else if (selected.type === "VECTOR" && linked?.targetFromOutput && linked.targetId === selected.id) {
        state = "ready";
        message = "Editable path selected \u2014 live preview is active.";
      } else if (selected.type === "VECTOR" && targetPathScore(selected) >= 1.5) {
        state = "path";
        message = "Path selected \u2014 now select a source.";
      } else {
        state = "source";
        message = "Source selected \u2014 now select a vector path.";
      }
    } else if (selection.length === 2) {
      const resolved = resolveSourceAndTarget(selection[0], selection[1]);
      if (resolved) {
        state = "ready";
        message = "Source and path selected \u2014 ready to start.";
      } else {
        state = "invalid";
        message = "Selection needs one source and one vector path.";
      }
    } else if (selection.length > 2) {
      state = "invalid";
      message = "Select exactly two layers: source and path.";
    }
    figma.ui.postMessage({ type: "selection", state, message });
  }
  function postStatus(message, isError = false) {
    figma.ui.postMessage({ type: isError ? "error" : "status", message });
  }
  function targetPathScore(node) {
    const curves = extractTargetCurves(node, false);
    const length = curves.reduce((sum, curve) => sum + approximateCubicLength(curve, 16), 0);
    const bounds = node.absoluteBoundingBox;
    const diagonal = bounds ? Math.hypot(bounds.width, bounds.height) || 1 : 1;
    const regions = node.vectorNetwork.regions?.length ?? 0;
    const fillPenalty = Array.isArray(node.fills) && node.fills.length > 0 ? 1 : 0;
    return length / diagonal + (regions === 0 ? 2 : -2) - fillPenalty;
  }
})();
