import { MinuteOiRecorder } from "./MinuteOiRecorder.js";
import { CvdRecorder } from "./CvdRecorder.js";
import { MinuteMarketRecorder } from "./MinuteMarketRecorder.js";
import { readResolvedRecorderSettings } from "./recorderSettingsStore.js";
import { readDatasetHistory } from "../dataset/datasetHistoryStore.js";
import { setRecorderUniverseById } from "./recorderUniverseStore.js";

export const minuteOiRecorder = new MinuteOiRecorder();
export const cvdRecorder = new CvdRecorder();
export const minuteMarketRecorder = new MinuteMarketRecorder();

{
  const settings = readResolvedRecorderSettings();
  if (settings.mode !== "off" && settings.historyId) {
    try {
      const history = readDatasetHistory(settings.historyId);
      setRecorderUniverseById(history.universeId);
    } catch {
      // Keep recorder settings even if history row was deleted; UI can repair or disable it later.
    }
  }
  minuteOiRecorder.setMode(settings.mode);
  cvdRecorder.setMode(settings.mode);
  minuteMarketRecorder.setMode(settings.mode);
}
