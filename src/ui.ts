export {};

type SelectionState = "none" | "source" | "path" | "ready" | "invalid";

interface UiSettings {
  type: "settings";
  livePreview: boolean;
  thicknessScale: number;
  patternOffset: number;
  pathSmoothing: number;
}

interface SettingsPayload {
  livePreview: boolean;
  thicknessScale: number;
  patternOffset: number;
  pathSmoothing: number;
}

interface StartMessage {
  type: "start";
}

interface PluginResponse {
  type: "status" | "error" | "selection" | "settings";
  message?: string;
  state?: SelectionState;
  settings?: SettingsPayload;
}

const livePreview = document.getElementById("livePreview") as HTMLInputElement;
const scale = document.getElementById("scale") as HTMLInputElement;
const scaleValue = document.getElementById("scaleValue") as HTMLOutputElement;
const patternOffset = document.getElementById("patternOffset") as HTMLInputElement;
const patternOffsetValue = document.getElementById("patternOffsetValue") as HTMLOutputElement;
const pathSmoothing = document.getElementById("pathSmoothing") as HTMLInputElement;
const pathSmoothingValue = document.getElementById("pathSmoothingValue") as HTMLOutputElement;
const start = document.getElementById("start") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const ranges = [scale, patternOffset, pathSmoothing];

function sendSettings() {
  const payload: UiSettings = {
    type: "settings",
    livePreview: livePreview.checked,
    thicknessScale: Number(scale.value) / 100,
    patternOffset: Number(patternOffset.value) / 100,
    pathSmoothing: Number(pathSmoothing.value)
  };
  parent.postMessage({ pluginMessage: payload }, "*");
}

function sendStart() {
  const payload: StartMessage = { type: "start" };
  parent.postMessage({ pluginMessage: payload }, "*");
}

function updateLabels() {
  scaleValue.value = `${scale.value}%`;
  const offset = Number(patternOffset.value);
  patternOffsetValue.value = `${offset > 0 ? "+" : ""}${offset}%`;
  pathSmoothingValue.value = pathSmoothing.value;
  for (const range of ranges) updateRangeProgress(range);
}

function applySettings(next: SettingsPayload) {
  livePreview.checked = next.livePreview;
  scale.value = String(Math.round(next.thicknessScale * 100));
  patternOffset.value = String(Math.round(next.patternOffset * 100));
  pathSmoothing.value = String(Math.round(next.pathSmoothing));
  updateLabels();
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

start.addEventListener("click", () => {
  updateLabels();
  sendSettings();
  sendStart();
});

for (const control of [livePreview, scale, patternOffset, pathSmoothing]) {
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
  if (message.type === "settings" && message.settings) {
    applySettings(message.settings);
    return;
  }
  if (message.type === "selection" && message.state && message.message) {
    setSelectionStatus(message.message, message.state);
    return;
  }
  setStatus(message.message ?? "", message.type === "error");
};

updateLabels();
