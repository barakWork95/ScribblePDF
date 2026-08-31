/**
 * Messages between the viewer and the service worker.
 * Kept in one place so both ends type-check against the same shape.
 */

export interface ExitEditorRequest {
  type: 'exitEditor';
  /** The original document URL to return the tab to. */
  url: string;
}

export interface ExitEditorResponse {
  ok: boolean;
  reason?: string;
}

export type Message = ExitEditorRequest;
