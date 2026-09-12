import type { DraftProgress } from "@turbopush/shared";

export type DraftProgressReporter = (progress: DraftProgress) => void;

export function reportDraftProgress(
  reporter: DraftProgressReporter | undefined,
  progress: DraftProgress,
) {
  try {
    reporter?.(progress);
  } catch {
    // Progress is observational. A telemetry/storage failure must never turn a
    // completed remote action into an apparent draft failure or trigger retry.
  }
}
