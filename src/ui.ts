export {};

type FitMethod = "repeat" | "stretch";
type SelectionState = "none" | "source" | "path" | "ready" | "invalid";

interface UiSettings {
  type: "settings";
  livePreview: boolean;
  thicknessScale: number;
  tileScale: number;
  patternOffset: number;
  smoothness: number;
  pathSmoothing: number;
  fitMethod: FitMethod;
}

interface StartMessage {
  type: "start";
}

interface PluginResponse {
  type: "status" | "error" | "selection";
  message: string;
  state?: SelectionState;
}

const livePreview = document.getElementById("livePreview") as HTMLInputElement;
const lockScale = document.getElementById("lockScale") as HTMLInputElement;
const scale = document.getElementById("scale") as HTMLInputElement;
const scaleValue = document.getElementById("scaleValue") as HTMLOutputElement;
const tileScale = document.getElementById("tileScale") as HTMLInputElement;
const tileScaleValue = document.getElementById("tileScaleValue") as HTMLOutputElement;
const patternOffset = document.getElementById("patternOffset") as HTMLInputElement;
const patternOffsetValue = document.getElementById("patternOffsetValue") as HTMLOutputElement;
const smoothness = document.getElementById("smoothness") as HTMLInputElement;
const smoothnessValue = document.getElementById("smoothnessValue") as HTMLOutputElement;
const pathSmoothing = document.getElementById("pathSmoothing") as HTMLInputElement;
const pathSmoothingValue = document.getElementById("pathSmoothingValue") as HTMLOutputElement;
const fit = document.getElementById("fit") as HTMLSelectElement;
const start = document.getElementById("start") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const ranges = [scale, tileScale, patternOffset, smoothness, pathSmoothing];

function sendSettings() {
  const payload: UiSettings = {
    type: "settings",
    livePreview: livePreview.checked,
    thicknessScale: Number(scale.value) / 100,
    tileScale: Number(tileScale.value) / 100,
    patternOffset: Number(patternOffset.value) / 100,
    smoothness: Number(smoothness.value),
    pathSmoothing: Number(pathSmoothing.value),
    fitMethod: fit.value as FitMethod
  };
  parent.postMessage({ pluginMessage: payload }, "*");
}

function sendStart() {
  const payload: StartMessage = { type: "start" };
  parent.postMessage({ pluginMessage: payload }, "*");
}

function updateLabels() {
  scaleValue.value = `${scale.value}%`;
  tileScaleValue.value = `${tileScale.value}%`;
  const offset = Number(patternOffset.value);
  patternOffsetValue.value = `${offset > 0 ? "+" : ""}${offset}%`;
  smoothnessValue.value = smoothness.value;
  pathSmoothingValue.value = pathSmoothing.value;
  for (const range of ranges) updateRangeProgress(range);
}

function setStatus(message: string, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
  status.classList.toggle("success", !isError && message.startsWith("Preview updated"));
  if (isError) status.dataset.state = "invalid";
  if (!isError && message.startsWith("Preview updated")) status.dataset.state = "ready";
}

function setSelectionStatus(message: string, state: SelectionState) {
  status.textContent = message;
  status.dataset.state = state;
  status.classList.toggle("error", state === "invalid");
  status.classList.remove("success");
}

function updateRangeProgress(range: HTMLInputElement) {
  const min = Number(range.min);
  const max = Number(range.max);
  const value = Number(range.value);
  const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
  range.style.setProperty("--range-progress", `${progress}%`);
}

function syncScaleControls(changed: HTMLInputElement) {
  if (!lockScale.checked) return;
  if (changed === scale) tileScale.value = scale.value;
  if (changed === tileScale) scale.value = tileScale.value;
}

start.addEventListener("click", () => {
  updateLabels();
  sendSettings();
  sendStart();
});

scale.addEventListener("input", () => {
  syncScaleControls(scale);
  updateLabels();
  sendSettings();
});

tileScale.addEventListener("input", () => {
  syncScaleControls(tileScale);
  updateLabels();
  sendSettings();
});

scale.addEventListener("change", () => {
  syncScaleControls(scale);
  updateLabels();
  sendSettings();
});

tileScale.addEventListener("change", () => {
  syncScaleControls(tileScale);
  updateLabels();
  sendSettings();
});

for (const control of [livePreview, lockScale, patternOffset, smoothness, pathSmoothing, fit]) {
  control.addEventListener("input", () => {
    updateLabels();
    sendSettings();
  });
  control.addEventListener("change", () => {
    updateLabels();
    sendSettings();
  });
}

window.onmessage = (event: MessageEvent) => {
  const message = event.data.pluginMessage as PluginResponse | undefined;
  if (!message) return;
  if (message.type === "selection" && message.state) {
    setSelectionStatus(message.message, message.state);
    return;
  }
  setStatus(message.message, message.type === "error");
};

updateLabels();
sendSettings();
