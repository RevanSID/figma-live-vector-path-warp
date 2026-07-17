export {};

type SelectionState = "none" | "source" | "path" | "ready" | "invalid";

interface UiSettings {
  type: "settings";
  livePreview: boolean;
  lockScale: boolean;
  thicknessScale: number;
  tileScale: number;
  patternOffset: number;
  pathSmoothing: number;
}

interface InternalSettings extends UiSettings {
  smoothness: number;
}

interface PersistedSettings {
  livePreview: boolean;
  lockScale: boolean;
  thicknessScale: number;
  tileScale: number;
  patternOffset: number;
  pathSmoothing: number;
}

interface StartMessage {
  type: "start";
}

interface ResizeMessage {
  type: "resize";
  height: number;
}

type UiMessage = UiSettings | StartMessage | ResizeMessage;

interface Point {
  x: number;
  y: number;
}

interface Cubic {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
}

interface TargetCurvePart {
  curve: Cubic;
  startVertex: number;
  endVertex: number;
}

interface ArcSample {
  curveIndex: number;
  t: number;
  length: number;
}

interface ArcTable {
  curves: Cubic[];
  samples: ArcSample[];
  totalLength: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

interface LinkedState {
  sourceId: string;
  targetId: string;
  outputId?: string;
  outputMeta?: OutputMeta;
  sourceFromOutput: boolean;
  targetFromOutput: boolean;
}

interface OutputMeta {
  id: string;
  name: string;
  parentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WarpedPiece {
  name: string;
  network: VectorNetwork;
}

interface OutputFrameResult {
  frame: FrameNode;
  sourceSnapshot: SceneNode;
  targetGuide: VectorNode;
}

interface RegionPart {
  tileIndex: number;
  regionIndex: number;
  name: string;
  network: VectorNetwork;
  fills?: Paint[];
  strokes?: Paint[];
}

const EPSILON = 1e-6;
const TARGET_SAMPLE_PX = 3;
const DEFAULT_SOURCE_SMOOTHNESS = 10;
const OUTPUT_NAME_PREFIX = "Live Vector Path Warp";
const OUTPUT_SOURCE_NAME = "__Live Vector Path Warp Source Snapshot";
const OUTPUT_TARGET_NAME = "__Live Vector Path Warp Editable Path";
const SNAPSHOT_GAP = 24;

let settings: InternalSettings = {
  type: "settings",
  livePreview: true,
  lockScale: true,
  thicknessScale: 1,
  tileScale: 1,
  patternOffset: 0,
  smoothness: DEFAULT_SOURCE_SMOOTHNESS,
  pathSmoothing: 2
};

let linked: LinkedState | null = null;
let renderTimer: number | undefined;
let isRendering = false;
let pendingRender = false;
let pendingRenderForce = false;
let lastRenderKey = "";
let detachOutputOnNextRender = false;
let arrangeSnapshotsOnNextRender = false;
let autoArrangeSnapshotIds: string[] = [];

figma.showUI(__html__, { width: 320, height: 500, themeColors: true });

figma.on("selectionchange", () => {
  if (isRendering) return;
  const replacementSelected = resolveOutputReplacementSelection(figma.currentPage.selection);
  const restored = restoreLinkedOutputFromSelection();
  postSelectionStatus();
  if (replacementSelected) return;
  scheduleRender(restored ? "output selection" : "selection", restored ? 20 : 140, restored);
});

figma.ui.onmessage = (message: UiMessage) => {
  if (message.type === "start") {
    startFromSelection();
    return;
  }

  if (message.type === "resize") {
    const height = Number.isFinite(message.height) ? Math.ceil(message.height) : 500;
    figma.ui.resize(320, Math.max(240, height));
    return;
  }

  if (message.type === "settings") {
    settings = { ...settings, ...message, smoothness: DEFAULT_SOURCE_SMOOTHNESS };
    scheduleRender("settings", 20, true);
  }
};

void initializeDocumentWatcher();
const restoredOnLaunch = restoreLinkedOutputFromSelection();
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
  const rawSelection = figma.currentPage.selection;
  const replacement = resolveOutputReplacementSelection(rawSelection);
  if (replacement) {
    applyPersistedSettings(replacement.embedded.persistedSettings);
    linked = {
      sourceId: replacement.source.id,
      targetId: replacement.embedded.targetGuide.id,
      outputId: replacement.frame.id,
      outputMeta: captureOutputMeta(replacement.frame),
      sourceFromOutput: false,
      targetFromOutput: true
    };
    detachOutputOnNextRender = false;
    arrangeSnapshotsOnNextRender = false;
    lastRenderKey = "";
    postStatus(`New source linked to ${replacement.embedded.targetGuide.name}. Existing path will be kept.`);
    scheduleRender("replace source", 20, true);
    return;
  }

  if (getSelectedOutputFrame()) {
    restoreLinkedOutputFromSelection();
    postStatus("Live frame restored. Editable path is selected.");
    lastRenderKey = "";
    scheduleRender("restore", 20, true);
    return;
  }

  const selection = rawSelection.filter((node) => !isCurrentOutput(node));
  if (selection.length !== 2) {
    postStatus("Нужно выделить ровно 2 слоя: source и vector path.", true);
    return;
  }

  const resolved = resolveSourceAndTarget(selection[0], selection[1]);
  if (!resolved) {
    postStatus("Выдели source layer/frame/component и target vector path.", true);
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
  detachOutputOnNextRender = linked.outputId !== undefined;
  arrangeSnapshotsOnNextRender = linked.outputId !== undefined;
  lastRenderKey = "";
  postStatus(`Linked: ${resolved.source.name} -> ${resolved.target.name}`);
  scheduleRender("start", 20, true);
}

function resolveSourceAndTarget(a: SceneNode, b: SceneNode): { source: SceneNode; target: VectorNode } | null {
  if (a.type === "VECTOR" && b.type !== "VECTOR") return { source: b, target: a };
  if (b.type === "VECTOR" && a.type !== "VECTOR") return { source: a, target: b };
  if (a.type === "VECTOR" && b.type === "VECTOR") {
    return targetPathScore(a) >= targetPathScore(b) ? { source: b, target: a } : { source: a, target: b };
  }
  return null;
}

function resolveOutputReplacementSelection(selection: readonly SceneNode[]): {
  frame: FrameNode;
  source: SceneNode;
  embedded: NonNullable<ReturnType<typeof findEmbeddedOutputParts>>;
} | null {
  if (selection.length !== 2) return null;

  const frame = selection.map(findOutputFrameForNode).find((candidate): candidate is FrameNode => candidate !== null);
  if (!frame) return null;

  const source = selection.find((node) => findOutputFrameForNode(node)?.id !== frame.id);
  if (!source) return null;

  const embedded = findEmbeddedOutputParts(frame);
  if (!embedded || source.id === embedded.targetGuide.id || source.id === embedded.sourceSnapshot.id) return null;
  return { frame, source, embedded };
}

function scheduleRender(reason: string, delay = 140, force = false) {
  if ((!settings.livePreview && !force) || !linked) return;
  if (isRendering) {
    pendingRender = true;
    pendingRenderForce = pendingRenderForce || force;
    return;
  }
  if (renderTimer !== undefined) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = undefined;
    void renderLivePreview(reason, force);
  }, delay) as unknown as number;
}

async function renderLivePreview(_reason: string, force = false) {
  if (!linked || isRendering || (!settings.livePreview && !force)) return;
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
      postStatus("Source или path больше недоступны. Выдели пару заново.", true);
      return;
    }

    const targetCurves = extractTargetCurves(target);
    const rawArcTable = buildArcTable(targetCurves);
    const arcTable = smoothArcTable(rawArcTable, settings.pathSmoothing);
    if (arcTable.totalLength <= EPSILON) {
      postStatus("Target path слишком короткий.", true);
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
    const warpedPieces = buildRepeatedPieces(
      preparedNetwork,
      sourceBounds,
      arcTable,
      settings.thicknessScale,
      settings.tileScale,
      settings.patternOffset
    );

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
    postStatus(`Preview updated: ${source.name}. Repeat vector. Tiles: ${warpedPieces.length}. Segments: ${segmentCount}.`);
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

function buildRenderKey(sourceId: string, targetId: string, arcTable: ArcTable): string {
  return [
    sourceId,
    targetId,
    arcSignature(arcTable),
    settings.thicknessScale,
    settings.tileScale,
    settings.patternOffset,
    settings.smoothness,
    settings.pathSmoothing
  ].join("|");
}

function flattenSourceToVector(source: SceneNode): VectorNode {
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

async function createOutputFrame(
  flattened: VectorNode,
  source: SceneNode,
  target: VectorNode,
  warpedPieces: WarpedPiece[],
  clipNetwork: VectorNetwork,
  skipRegionCount: number
): Promise<OutputFrameResult> {
  const previous = linked?.outputId ? await figma.getNodeByIdAsync(linked.outputId) : null;
  const previousScene = previous && isSceneNode(previous) ? previous : null;
  const previousParent = previousScene?.parent && hasChildren(previousScene.parent) ? previousScene.parent : null;
  const previousIndex = previousParent && previousScene ? previousParent.children.indexOf(previousScene) : -1;
  let keepPrevious = false;
  if (previous && "remove" in previous) {
    keepPrevious = detachOutputOnNextRender || (previousScene !== null && isOutputTouched(previousScene));
    if (keepPrevious) {
      if (detachOutputOnNextRender && previousScene) rememberAutoArrangeSnapshot(previousScene);
    }
  }
  const reusableTargetTransform =
    !keepPrevious &&
    linked?.targetFromOutput === true &&
    previousScene !== null &&
    target.parent?.id === previousScene.id
      ? target.absoluteTransform
      : null;

  const networkBounds = boundsFromNetwork(clipNetwork);
  const padding = 2;
  const frameOrigin = { x: networkBounds.minX - padding, y: networkBounds.minY - padding };
  const frameWidth = Math.max(1, networkBounds.width + padding * 2);
  const frameHeight = Math.max(1, networkBounds.height + padding * 2);

  const reuseOutputPlacement = linked?.targetFromOutput === true && previousParent !== null && previousIndex >= 0;
  const parent = reuseOutputPlacement
    ? previousParent
    : target.parent && hasChildren(target.parent)
      ? target.parent
      : figma.currentPage;
  const targetIndex = reuseOutputPlacement ? previousIndex : parent.children.indexOf(target);

  const frame = figma.createFrame();
  frame.name = `${OUTPUT_NAME_PREFIX} - multi-tile - ${flattened.name.replace(" - warp source flatten", "")}`;
  frame.clipsContent = true;
  frame.fills = [];
  frame.strokes = [];
  frame.resizeWithoutConstraints(frameWidth, frameHeight);
  frame.relativeTransform = absolutePageTransformForParent(parent, frameOrigin);
  parent.insertChild(Math.min(parent.children.length, targetIndex + 1), frame);

  const sourceSnapshot = cloneSceneNodeIntoParent(source, frame, buildSourceSnapshotName(settings), false, { x: 4, y: 4 });
  const targetGuide = reusableTargetTransform
    ? target
    : cloneSceneNodeIntoParent(target, frame, OUTPUT_TARGET_NAME, true);
  if (targetGuide.type !== "VECTOR") throw new Error("The embedded editable path must remain a vector node.");
  if (reusableTargetTransform) {
    frame.appendChild(targetGuide);
    targetGuide.locked = false;
    targetGuide.name = OUTPUT_TARGET_NAME;
    targetGuide.visible = true;
    targetGuide.relativeTransform = relativeTransformForParent(frame, reusableTargetTransform);
  }
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

function buildRegionStackedParts(warpedPieces: WarpedPiece[], flattened: VectorNode, skipRegionCount: number): RegionPart[] {
  const perTileParts = warpedPieces.map((piece, tileIndex) => splitNetworkIntoRegionParts(piece.network, tileIndex, flattened, skipRegionCount));
  const maxRegionIndex = Math.max(...perTileParts.flat().map((part) => part.regionIndex), -1);
  const ordered: RegionPart[] = [];

  for (let regionIndex = 0; regionIndex <= maxRegionIndex; regionIndex += 1) {
    for (const tileParts of perTileParts) {
      ordered.push(...tileParts.filter((part) => part.regionIndex === regionIndex));
    }
  }

  return ordered;
}

function buildTileStackedParts(warpedPieces: WarpedPiece[], flattened: VectorNode, skipRegionCount: number): RegionPart[] {
  return warpedPieces.flatMap((piece, tileIndex) => splitNetworkIntoRegionParts(piece.network, tileIndex, flattened, skipRegionCount));
}

function splitNetworkIntoRegionParts(network: VectorNetwork, tileIndex: number, flattened: VectorNode, skipRegionCount: number): RegionPart[] {
  const parts: RegionPart[] = [];
  const usedSegments = new Set<number>();

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

function subsetNetworkForRegion(network: VectorNetwork, region: VectorRegion, segmentIndices: number[]): VectorNetwork {
  const supportedFills = sanitizePaints(region.fills ?? []);
  const remapped = subsetNetworkForSegments(network, segmentIndices, region.loops);
  const remappedRegion = remapped.regions?.[0];
  if (!remappedRegion) return remapped;
  return {
    ...remapped,
    regions: [
      {
        ...remappedRegion,
        ...(supportedFills && supportedFills.length > 0 ? { fills: supportedFills } : {})
      }
    ]
  };
}

function subsetNetworkForSegments(network: VectorNetwork, segmentIndices: number[], sourceLoops: readonly (readonly number[])[]): VectorNetwork {
  const segmentMap = new Map<number, number>();
  const vertexMap = new Map<number, number>();
  const vertices: VectorVertex[] = [];
  const segments: VectorSegment[] = [];

  const mapVertex = (index: number) => {
    const existing = vertexMap.get(index);
    if (existing !== undefined) return existing;
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

  const loops = sourceLoops
    .map((loop) => loop.map((segmentIndex) => segmentMap.get(segmentIndex)).filter((index): index is number => index !== undefined))
    .filter((loop) => loop.length > 0);

  return {
    vertices,
    segments,
    regions: loops.length > 0 ? [{ windingRule: "NONZERO", loops }] : []
  };
}

function insertContainerBackgroundIntoClone(clone: SceneNode, source: SceneNode) {
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

function outlineStrokesBeforeFlatten(root: SceneNode): VectorNode[] {
  const topLevelOutlines: VectorNode[] = [];

  const visit = (node: SceneNode) => {
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

function createStrokeOutlineSibling(node: SceneNode): VectorNode | null {
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

function hasOutlineableStroke(node: SceneNode): node is SceneNode & GeometryMixin {
  return "strokes" in node && "outlineStroke" in node;
}

function buildPathEnvelopeNetwork(arcTable: ArcTable, height: number): VectorNetwork {
  const sampleCount = Math.max(24, Math.ceil(arcTable.totalLength / 12));
  const halfHeight = height / 2;
  const top: VectorVertex[] = [];
  const bottom: VectorVertex[] = [];

  for (let index = 0; index <= sampleCount; index += 1) {
    const sample = evaluateAtLength(arcTable, (arcTable.totalLength * index) / sampleCount);
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
  const segments: VectorSegment[] = [];
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

async function normalizeVectorNetworkPaints(network: VectorNetwork): Promise<VectorNetwork> {
  const regions: VectorRegion[] = [];
  for (const region of network.regions ?? []) {
    const fills = region.fills ? await normalizePaints(region.fills) : region.fills;
    regions.push({ ...region, fills });
  }
  return { ...network, regions };
}

async function normalizePaints(paints: readonly Paint[]): Promise<Paint[]> {
  return sanitizePaints(paints);
}

function sanitizePaints(paints: readonly Paint[]): Paint[] {
  return paints.filter(isSettablePaint);
}

function isSettablePaint(paint: Paint): paint is SolidPaint | GradientPaint | ImagePaint | VideoPaint | ShaderPaint {
  return paint.type !== "PATTERN";
}

function hasChildren(node: BaseNode): node is BaseNode & ChildrenMixin {
  return "children" in node && "insertChild" in node;
}

function captureOutputMeta(node: SceneNode): OutputMeta | undefined {
  const bounds = node.absoluteBoundingBox;
  if (!bounds || !node.parent) return undefined;
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

function isOutputTouched(node: SceneNode): boolean {
  const meta = linked?.outputMeta;
  const bounds = node.absoluteBoundingBox;
  if (!meta || !bounds || !node.parent) return false;
  return (
    node.name !== meta.name ||
    node.parent.id !== meta.parentId ||
    Math.abs(bounds.x - meta.x) > 0.5 ||
    Math.abs(bounds.y - meta.y) > 0.5 ||
    Math.abs(bounds.width - meta.width) > 0.5 ||
    Math.abs(bounds.height - meta.height) > 0.5
  );
}

function rememberAutoArrangeSnapshot(node: SceneNode) {
  autoArrangeSnapshotIds = [node.id, ...autoArrangeSnapshotIds.filter((id) => id !== node.id)];
}

async function arrangeSnapshotsRightOf(activeFrame: FrameNode) {
  const activeBounds = activeFrame.absoluteBoundingBox;
  if (!activeBounds) return;

  let cursorX = activeBounds.x + activeBounds.width + SNAPSHOT_GAP;
  const y = activeBounds.y;
  const existingIds: string[] = [];

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

function absolutePageTransformForParent(parent: BaseNode & ChildrenMixin, pageOrigin: Point): Transform {
  if (parent.type === "PAGE") {
    return [
      [1, 0, pageOrigin.x],
      [0, 1, pageOrigin.y]
    ];
  }

  const inverse = invertTransform((parent as SceneNode).absoluteTransform);
  return multiplyTransform(inverse, [
    [1, 0, pageOrigin.x],
    [0, 1, pageOrigin.y]
  ]);
}

function relativeTransformForParent(parent: BaseNode & ChildrenMixin, absoluteTransform: Transform): Transform {
  if (parent.type === "PAGE") return absoluteTransform;
  return multiplyTransform(invertTransform((parent as SceneNode).absoluteTransform), absoluteTransform);
}

function cloneSceneNodeIntoParent(
  source: SceneNode,
  parent: BaseNode & ChildrenMixin,
  name: string,
  visible: boolean,
  localOrigin?: Point
): SceneNode {
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

function selectEditablePath(path: VectorNode) {
  figma.currentPage.selection = [path];
}

function translateNetwork(network: VectorNetwork, dx: number, dy: number): VectorNetwork {
  return {
    vertices: network.vertices.map((vertex) => ({ ...vertex, x: vertex.x + dx, y: vertex.y + dy })),
    segments: network.segments.map((segment) => ({ ...segment })),
    regions: network.regions ? network.regions.map(copyRegion) : []
  };
}

function boundsFromNetwork(network: VectorNetwork): Bounds {
  const points: Point[] = [];
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

function boundsFromNetworks(networks: VectorNetwork[]): Bounds {
  if (networks.length === 0) throw new Error("No warped vector pieces were generated.");
  const bounds = networks.map(boundsFromNetwork);
  const minX = Math.min(...bounds.map((item) => item.minX));
  const minY = Math.min(...bounds.map((item) => item.minY));
  const maxX = Math.max(...bounds.map((item) => item.maxX));
  const maxY = Math.max(...bounds.map((item) => item.maxY));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function subdivideNetworkForWarp(network: VectorNetwork, smoothness: number): VectorNetwork {
  const quality = Math.max(1, Math.min(10, Math.round(smoothness)));
  const maxSourceXStep = 32 / quality;
  const maxPiecesPerSegment = quality * 12;
  const vertices: VectorVertex[] = network.vertices.map((vertex) => ({ ...vertex }));
  const segments: VectorSegment[] = [];
  const segmentMap = new Map<number, number[]>();

  network.segments.forEach((segment, segmentIndex) => {
    const cubic = sourceSegmentToCubic(network, segment);
    const piecesCount = sourceSubdivisionCount(cubic, maxSourceXStep, maxPiecesPerSegment);
    const mappedSegmentIndices: number[] = [];

    if (piecesCount <= 1) {
      mappedSegmentIndices.push(segments.length);
      segments.push({ ...segment });
      segmentMap.set(segmentIndex, mappedSegmentIndices);
      return;
    }

    const pieces = splitCubicIntoEqualPieces(cubic, piecesCount);
    let currentStart = segment.start;
    pieces.forEach((piece, pieceIndex) => {
      const currentEnd =
        pieceIndex === pieces.length - 1
          ? segment.end
          : addSubdivisionVertex(vertices, network.vertices[segment.start], network.vertices[segment.end], piece.p3, pieceIndex / pieces.length);
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
    loops: region.loops.map((loop) =>
      orientLoop(network, loop).flatMap((item) => {
        const mapped = segmentMap.get(item.segmentIndex) ?? [];
        return item.reversed ? [...mapped].reverse() : mapped;
      })
    )
  }));

  return { vertices, segments, regions };
}

function sourceSubdivisionCount(cubic: Cubic, maxSourceXStep: number, maxPiecesPerSegment: number): number {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (let index = 0; index <= 12; index += 1) {
    const point = cubicPoint(cubic, index / 12);
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
  }
  return Math.max(1, Math.min(maxPiecesPerSegment, Math.ceil((maxX - minX) / maxSourceXStep)));
}

function addSubdivisionVertex(vertices: VectorVertex[], start: VectorVertex, end: VectorVertex, point: Point, t: number): number {
  const strokeCap = start.strokeCap !== undefined && start.strokeCap === end.strokeCap ? start.strokeCap : undefined;
  const strokeJoin = start.strokeJoin !== undefined && start.strokeJoin === end.strokeJoin ? start.strokeJoin : undefined;
  const cornerRadius =
    start.cornerRadius !== undefined || end.cornerRadius !== undefined
      ? lerp(start.cornerRadius ?? 0, end.cornerRadius ?? 0, t)
      : undefined;
  vertices.push({
    x: point.x,
    y: point.y,
    ...(strokeCap !== undefined ? { strokeCap } : {}),
    ...(strokeJoin !== undefined ? { strokeJoin } : {}),
    ...(cornerRadius !== undefined ? { cornerRadius } : {})
  });
  return vertices.length - 1;
}

function warpSingle(
  network: VectorNetwork,
  bounds: Bounds,
  arcTable: ArcTable,
  thicknessScale: number,
  arcStart: number,
  arcSpan: number,
  extendBeyondPath: boolean
): VectorNetwork {
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

function buildRepeatedPieces(
  network: VectorNetwork,
  bounds: Bounds,
  arcTable: ArcTable,
  thicknessScale: number,
  tileScale: number,
  patternOffset: number
): WarpedPiece[] {
  const normalizedTileScale = Math.max(0.05, tileScale);
  const tileArcLength = bounds.width * normalizedTileScale;
  const offset = patternOffset * tileArcLength;
  const firstTile = Math.floor(-offset / tileArcLength);
  const lastTile = Math.ceil((arcTable.totalLength - offset) / tileArcLength) - 1;
  const pieces: WarpedPiece[] = [];

  for (let tile = firstTile; tile <= lastTile; tile += 1) {
    const arcStart = tile * tileArcLength + offset;
    pieces.push({
      name: `warped tile ${tile - firstTile + 1}`,
      network: warpSingle(network, bounds, arcTable, thicknessScale, arcStart, tileArcLength, true)
    });
  }

  return pieces;
}

function clipNetworkAtSourceX(network: VectorNetwork, maxX: number): VectorNetwork {
  const vertices: VectorVertex[] = [];
  const segments: VectorSegment[] = [];
  const vertexMap = new Map<number, number>();
  const segmentMap = new Map<number, number>();

  const addVertex = (vertex: VectorVertex): number => {
    vertices.push({ ...vertex });
    return vertices.length - 1;
  };
  const mappedVertex = (index: number): number => {
    const existing = vertexMap.get(index);
    if (existing !== undefined) return existing;
    const mapped = addVertex(network.vertices[index]);
    vertexMap.set(index, mapped);
    return mapped;
  };

  network.segments.forEach((segment, segmentIndex) => {
    const start = network.vertices[segment.start];
    const end = network.vertices[segment.end];
    const startInside = start.x <= maxX + EPSILON;
    const endInside = end.x <= maxX + EPSILON;

    if (startInside && endInside) {
      segmentMap.set(segmentIndex, segments.length);
      segments.push({ ...segment, start: mappedVertex(segment.start), end: mappedVertex(segment.end) });
      return;
    }
    if (!startInside && !endInside) return;

    const cubic = sourceSegmentToCubic(network, segment);
    const t = findCubicXCrossing(cubic, maxX);
    if (t <= EPSILON || t >= 1 - EPSILON) return;
    const split = splitCubic(cubic, t);

    segmentMap.set(segmentIndex, segments.length);
    if (startInside) {
      const startIndex = mappedVertex(segment.start);
      const cutIndex = addVertex({ ...end, x: split.left.p3.x, y: split.left.p3.y });
      segments.push({
        ...segment,
        start: startIndex,
        end: cutIndex,
        tangentStart: subtract(split.left.p1, split.left.p0),
        tangentEnd: subtract(split.left.p2, split.left.p3)
      });
    } else {
      const cutIndex = addVertex({ ...start, x: split.right.p0.x, y: split.right.p0.y });
      const endIndex = mappedVertex(segment.end);
      segments.push({
        ...segment,
        start: cutIndex,
        end: endIndex,
        tangentStart: subtract(split.right.p1, split.right.p0),
        tangentEnd: subtract(split.right.p2, split.right.p3)
      });
    }
  });

  const regions: VectorRegion[] = [];
  for (const region of network.regions ?? []) {
    const loops: number[][] = [];
    for (const loop of region.loops) {
      const mappedLoop: number[] = [];
      let completeLoop = true;
      for (const segmentIndex of loop) {
        const mappedSegmentIndex = segmentMap.get(segmentIndex);
        if (mappedSegmentIndex === undefined) {
          completeLoop = false;
          break;
        }
        mappedLoop.push(mappedSegmentIndex);
      }
      if (completeLoop) loops.push(mappedLoop);
    }
    if (loops.length > 0) regions.push({ ...region, loops });
  }
  return { vertices, segments, regions };
}

function warpPoint(
  point: Point,
  bounds: Bounds,
  baselineY: number,
  arcTable: ArcTable,
  thicknessScale: number,
  arcStart: number,
  arcSpan: number,
  extendBeyondPath: boolean
): Point {
  const u = (point.x - bounds.minX) / bounds.width;
  const sample = extendBeyondPath ? evaluateAtLengthExtended(arcTable, arcStart + u * arcSpan) : evaluateAtLength(arcTable, arcStart + u * arcSpan);
  const normal = { x: -sample.tangent.y, y: sample.tangent.x };
  const offset = (point.y - baselineY) * thicknessScale;
  return { x: sample.point.x + normal.x * offset, y: sample.point.y + normal.y * offset };
}

function extractTargetCurves(node: VectorNode, throwOnEmpty = true): Cubic[] {
  const network = node.vectorNetwork;
  const pageVertices = network.vertices.map((vertex) => transformPoint(node.absoluteTransform, vertex));

  const segmentToCubic = (segmentIndex: number, reversed: boolean): TargetCurvePart | null => {
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
  const ordered = chains
    .map((chain) => chain.map((item) => segmentToCubic(item.segmentIndex, item.reversed)).filter((part): part is TargetCurvePart => part !== null))
    .filter((chain) => chain.length > 0);
  const longest = ordered.sort((a, b) => chainLength(b.map((part) => part.curve)) - chainLength(a.map((part) => part.curve)))[0];
  if (!longest && throwOnEmpty) throw new Error("Target vector does not contain a usable continuous path.");
  return longest ? roundTargetCorners(longest, network, node.absoluteTransform) : [];
}

function roundTargetCorners(parts: TargetCurvePart[], network: VectorNetwork, transform: Transform): Cubic[] {
  if (parts.length === 0) return [];

  const startTrim = parts.map(() => 0);
  const endTrim = parts.map(() => 1);
  const corners = new Map<number, Cubic>();
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
    const handleLength = (4 / 3) * Math.tan(turnAngle / 4) * effectiveRadius;

    endTrim[index] = incomingT;
    startTrim[nextIndex] = outgoingT;
    corners.set(index, {
      p0: start,
      p1: { x: start.x + arrivalAtTrim.x * handleLength, y: start.y + arrivalAtTrim.y * handleLength },
      p2: { x: end.x - leaveAtTrim.x * handleLength, y: end.y - leaveAtTrim.y * handleLength },
      p3: end
    });
  }

  const curves: Cubic[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const trimmed = trimCubic(parts[index].curve, startTrim[index], endTrim[index]);
    if (trimmed && approximateCubicLength(trimmed, 8) > EPSILON) curves.push(trimmed);
    const corner = corners.get(index);
    if (corner && approximateCubicLength(corner, 8) > EPSILON) curves.push(corner);
  }
  return curves;
}

function orderedOpenChains(network: VectorNetwork) {
  const adjacency = new Map<number, number[]>();
  network.segments.forEach((segment, index) => {
    adjacency.set(segment.start, [...(adjacency.get(segment.start) ?? []), index]);
    adjacency.set(segment.end, [...(adjacency.get(segment.end) ?? []), index]);
  });

  const unused = new Set(network.segments.map((_, index) => index));
  const chains: Array<Array<{ segmentIndex: number; reversed: boolean }>> = [];
  while (unused.size > 0) {
    const seed = unused.values().next().value;
    if (seed === undefined) break;
    const component = collectComponent(network, seed, adjacency);
    const endpoints = Array.from(component.vertices).filter((vertex) => (adjacency.get(vertex) ?? []).filter((index) => component.segments.has(index)).length === 1);
    let cursor = endpoints[0] ?? component.vertices.values().next().value;
    const chain: Array<{ segmentIndex: number; reversed: boolean }> = [];
    while (cursor !== undefined) {
      const next = (adjacency.get(cursor) ?? []).find((index) => unused.has(index) && component.segments.has(index));
      if (next === undefined) break;
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

function collectComponent(network: VectorNetwork, startSegmentIndex: number, adjacency: Map<number, number[]>) {
  const segments = new Set<number>();
  const vertices = new Set<number>();
  const queue = [startSegmentIndex];
  while (queue.length > 0) {
    const segmentIndex = queue.shift();
    if (segmentIndex === undefined || segments.has(segmentIndex)) continue;
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

function orientLoop(network: VectorNetwork, loop: readonly number[]) {
  const tryOrient = (firstReversed: boolean) => {
    if (loop.length === 0) return [];
    const result = [{ segmentIndex: loop[0], reversed: firstReversed }];
    let cursor = firstReversed ? network.segments[loop[0]]?.start : network.segments[loop[0]]?.end;
    if (cursor === undefined) return result;
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

function smoothArcTable(arcTable: ArcTable, smoothing: number): ArcTable {
  const level = Math.max(0, Math.min(10, Math.round(smoothing)));
  if (level === 0 || arcTable.totalLength <= EPSILON) return arcTable;

  const sampleSpacing = Math.max(4, 9 - level * 0.35);
  const sampleCount = Math.max(8, Math.min(1200, Math.ceil(arcTable.totalLength / sampleSpacing)));
  let points: Point[] = [];
  for (let index = 0; index <= sampleCount; index += 1) {
    points.push(evaluateAtLength(arcTable, (arcTable.totalLength * index) / sampleCount).point);
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

function smoothPointPass(points: Point[], radius: number, strength: number): Point[] {
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

function removeNearDuplicatePoints(points: Point[], minDistance: number): Point[] {
  const filtered: Point[] = [];
  for (const point of points) {
    const previous = filtered[filtered.length - 1];
    if (!previous || distance(previous, point) >= minDistance) filtered.push(point);
  }
  return filtered.length >= 2 ? filtered : points;
}

function catmullRomToCubics(points: Point[]): Cubic[] {
  const curves: Cubic[] = [];
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

function buildArcTable(curves: Cubic[]): ArcTable {
  const samples: ArcSample[] = [{ curveIndex: 0, t: 0, length: 0 }];
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

function evaluateAtLength(arcTable: ArcTable, requestedLength: number): { point: Point; tangent: Point } {
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

function evaluateAtLengthExtended(arcTable: ArcTable, requestedLength: number): { point: Point; tangent: Point } {
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

function arcSignature(arcTable: ArcTable): string {
  const parts = [Math.round(arcTable.totalLength).toString()];
  for (let index = 0; index <= 10; index += 1) {
    const sample = evaluateAtLength(arcTable, (arcTable.totalLength * index) / 10);
    parts.push(`${Math.round(sample.point.x)},${Math.round(sample.point.y)},${Math.round(sample.tangent.x * 100)},${Math.round(sample.tangent.y * 100)}`);
  }
  return parts.join(";");
}

function sourceSegmentToCubic(network: VectorNetwork, segment: VectorSegment): Cubic {
  const start = network.vertices[segment.start];
  const end = network.vertices[segment.end];
  return {
    p0: { x: start.x, y: start.y },
    p1: { x: start.x + (segment.tangentStart?.x ?? 0), y: start.y + (segment.tangentStart?.y ?? 0) },
    p2: { x: end.x + (segment.tangentEnd?.x ?? 0), y: end.y + (segment.tangentEnd?.y ?? 0) },
    p3: { x: end.x, y: end.y }
  };
}

function findCubicXCrossing(cubic: Cubic, maxX: number): number {
  let lo = 0;
  let hi = 1;
  const startInside = cubic.p0.x <= maxX;
  for (let index = 0; index < 30; index += 1) {
    const mid = (lo + hi) / 2;
    const point = cubicPoint(cubic, mid);
    const midInside = point.x <= maxX;
    if (midInside === startInside) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function splitCubicIntoEqualPieces(cubic: Cubic, count: number): Cubic[] {
  const pieces: Cubic[] = [];
  let remainder = cubic;
  for (let index = 0; index < count - 1; index += 1) {
    const split = splitCubic(remainder, 1 / (count - index));
    pieces.push(split.left);
    remainder = split.right;
  }
  pieces.push(remainder);
  return pieces;
}

function splitCubic(cubic: Cubic, t: number): { left: Cubic; right: Cubic } {
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

function trimCubic(cubic: Cubic, startT: number, endT: number): Cubic | null {
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

function cubicParameterAtLength(curve: Cubic, requestedLength: number): number {
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

function cubicPoint(curve: Cubic, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * curve.p0.x + 3 * mt2 * t * curve.p1.x + 3 * mt * t2 * curve.p2.x + t2 * t * curve.p3.x,
    y: mt2 * mt * curve.p0.y + 3 * mt2 * t * curve.p1.y + 3 * mt * t2 * curve.p2.y + t2 * t * curve.p3.y
  };
}

function cubicDerivative(curve: Cubic, t: number): Point {
  const mt = 1 - t;
  return {
    x: 3 * mt * mt * (curve.p1.x - curve.p0.x) + 6 * mt * t * (curve.p2.x - curve.p1.x) + 3 * t * t * (curve.p3.x - curve.p2.x),
    y: 3 * mt * mt * (curve.p1.y - curve.p0.y) + 6 * mt * t * (curve.p2.y - curve.p1.y) + 3 * t * t * (curve.p3.y - curve.p2.y)
  };
}

function approximateCubicLength(curve: Cubic, steps: number): number {
  let length = 0;
  let previous = cubicPoint(curve, 0);
  for (let index = 1; index <= steps; index += 1) {
    const current = cubicPoint(curve, index / steps);
    length += distance(previous, current);
    previous = current;
  }
  return length;
}

function chainLength(curves: Cubic[]): number {
  return curves.reduce((sum, curve) => sum + approximateCubicLength(curve, 12), 0);
}

function transformPoint(transform: Transform, point: Point): Point {
  return {
    x: transform[0][0] * point.x + transform[0][1] * point.y + transform[0][2],
    y: transform[1][0] * point.x + transform[1][1] * point.y + transform[1][2]
  };
}

function transformScale(transform: Transform): number {
  const xAxisScale = Math.hypot(transform[0][0], transform[1][0]);
  const yAxisScale = Math.hypot(transform[0][1], transform[1][1]);
  return Math.max(EPSILON, (xAxisScale + yAxisScale) / 2);
}

function invertTransform(transform: Transform): Transform {
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

function multiplyTransform(a: Transform, b: Transform): Transform {
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

function normalize(vector: Point, fallback: Point): Point {
  const length = Math.hypot(vector.x, vector.y);
  if (length <= EPSILON) return fallback;
  return { x: vector.x / length, y: vector.y / length };
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fallbackTangent(curve: Cubic): Point {
  return normalize({ x: curve.p3.x - curve.p0.x, y: curve.p3.y - curve.p0.y }, { x: 1, y: 0 });
}

function mixPoint(a: Point, b: Point, t: number): Point {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

function subtract(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function copyRegion(region: VectorRegion): VectorRegion {
  return { ...region, loops: region.loops.map((loop) => [...loop]) };
}

function offsetRegion(region: VectorRegion, segmentOffset: number): VectorRegion {
  return { ...region, loops: region.loops.map((loop) => loop.map((segmentIndex) => segmentIndex + segmentOffset)) };
}

function isSceneNode(node: BaseNode): node is SceneNode {
  return "visible" in node && "absoluteTransform" in node;
}

function isCurrentOutput(node: BaseNode): boolean {
  return linked?.outputId === node.id;
}

function buildSourceSnapshotName(currentSettings: InternalSettings): string {
  return [
    OUTPUT_SOURCE_NAME,
    "v=1",
    `live=${currentSettings.livePreview ? 1 : 0}`,
    `lock=${currentSettings.lockScale ? 1 : 0}`,
    `thickness=${currentSettings.thicknessScale.toFixed(4)}`,
    `tile=${currentSettings.tileScale.toFixed(4)}`,
    `offset=${currentSettings.patternOffset.toFixed(4)}`,
    `path=${Math.round(currentSettings.pathSmoothing)}`
  ].join("|");
}

function parseSourceSnapshotSettings(name: string): PersistedSettings | null {
  const prefix = `${OUTPUT_SOURCE_NAME}|`;
  if (!name.startsWith(prefix)) return null;

  const values: Record<string, string> = {};
  for (const item of name.slice(prefix.length).split("|")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    values[item.slice(0, separator)] = item.slice(separator + 1);
  }

  const thicknessScale = Number(values.thickness);
  const tileScale = Number(values.tile);
  const patternOffset = Number(values.offset);
  const pathSmoothing = Number(values.path);
  if (!Number.isFinite(thicknessScale) || !Number.isFinite(tileScale) || !Number.isFinite(patternOffset) || !Number.isFinite(pathSmoothing)) return null;

  return {
    livePreview: values.live === "1",
    lockScale: values.lock === "1",
    thicknessScale: clamp(thicknessScale, 0.1, 3),
    tileScale: clamp(tileScale, 0.1, 3),
    patternOffset: clamp(patternOffset, -1, 1),
    pathSmoothing: clamp(Math.round(pathSmoothing), 0, 10)
  };
}

function postSettingsToUi() {
  figma.ui.postMessage({
    type: "settings",
    settings: {
      livePreview: settings.livePreview,
      lockScale: settings.lockScale,
      thicknessScale: settings.thicknessScale,
      tileScale: settings.tileScale,
      patternOffset: settings.patternOffset,
      pathSmoothing: settings.pathSmoothing
    }
  });
}

function findEmbeddedOutputParts(frame: FrameNode): {
  sourceSnapshot: SceneNode;
  targetGuide: VectorNode;
  persistedSettings: PersistedSettings | null;
} | null {
  if (!frame.name.startsWith(OUTPUT_NAME_PREFIX)) return null;
  const namedTarget = frame.children.find((child): child is VectorNode => child.type === "VECTOR" && child.name === OUTPUT_TARGET_NAME);
  const firstChild = frame.children[0];
  const targetGuide = namedTarget ?? (firstChild?.type === "VECTOR" ? firstChild : null);
  const namedSource = frame.children.find((child) => child.name.startsWith(OUTPUT_SOURCE_NAME) && isSceneNode(child));
  const sourceSnapshot =
    namedSource ??
    frame.children.find((child) => isSceneNode(child) && child !== targetGuide && child.visible === false) ??
    null;
  if (!sourceSnapshot || !targetGuide) return null;
  return { sourceSnapshot, targetGuide, persistedSettings: parseSourceSnapshotSettings(sourceSnapshot.name) };
}

function findOutputFrameForNode(node: SceneNode): FrameNode | null {
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.type === "FRAME" && findEmbeddedOutputParts(current)) return current;
    current = current.parent;
  }
  return null;
}

function getSelectedOutputFrame(): FrameNode | null {
  const selection = figma.currentPage.selection;
  return selection.length === 1 ? findOutputFrameForNode(selection[0]) : null;
}

function restoreLinkedOutputFromSelection(): boolean {
  const frame = getSelectedOutputFrame();
  if (!frame) return false;
  const embedded = findEmbeddedOutputParts(frame);
  if (!embedded) return false;

  const alreadyLinked =
    linked?.outputId === frame.id &&
    linked.targetId === embedded.targetGuide.id;
  if (alreadyLinked) return false;

  applyPersistedSettings(embedded.persistedSettings);

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

function applyPersistedSettings(persistedSettings: PersistedSettings | null) {
  if (!persistedSettings) return;
  settings = {
    ...settings,
    ...persistedSettings,
    smoothness: DEFAULT_SOURCE_SMOOTHNESS
  };
  postSettingsToUi();
}

function postSelectionStatus() {
  const rawSelection = figma.currentPage.selection;
  if (resolveOutputReplacementSelection(rawSelection)) {
    figma.ui.postMessage({
      type: "selection",
      state: "ready",
      message: "Live frame + new source selected — ready to replace source."
    });
    return;
  }

  if (rawSelection.length === 1 && findOutputFrameForNode(rawSelection[0])) {
    figma.ui.postMessage({ type: "selection", state: "ready", message: "Live frame selected — path editing is ready." });
    return;
  }

  const selection = rawSelection.filter((node) => !isCurrentOutput(node));
  let state: SelectionState = "none";
  let message = "Select a source and a vector path.";

  if (selection.length === 1) {
    const selected = selection[0];
    if (findOutputFrameForNode(selected)) {
      state = "ready";
      message = "Live frame selected — path editing is ready.";
    } else if (selected.type === "VECTOR" && linked?.targetFromOutput && linked.targetId === selected.id) {
      state = "ready";
      message = "Editable path selected — live preview is active.";
    } else if (selected.type === "VECTOR" && targetPathScore(selected) >= 1.5) {
      state = "path";
      message = "Path selected — now select a source.";
    } else {
      state = "source";
      message = "Source selected — now select a vector path.";
    }
  } else if (selection.length === 2) {
    const resolved = resolveSourceAndTarget(selection[0], selection[1]);
    if (resolved) {
      state = "ready";
      message = "Source and path selected — ready to start.";
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

function postStatus(message: string, isError = false) {
  figma.ui.postMessage({ type: isError ? "error" : "status", message });
}

function targetPathScore(node: VectorNode): number {
  const curves = extractTargetCurves(node, false);
  const length = curves.reduce((sum, curve) => sum + approximateCubicLength(curve, 16), 0);
  const bounds = node.absoluteBoundingBox;
  const diagonal = bounds ? Math.hypot(bounds.width, bounds.height) || 1 : 1;
  const regions = node.vectorNetwork.regions?.length ?? 0;
  const fillPenalty = Array.isArray(node.fills) && node.fills.length > 0 ? 1 : 0;
  return length / diagonal + (regions === 0 ? 2 : -2) - fillPenalty;
}
