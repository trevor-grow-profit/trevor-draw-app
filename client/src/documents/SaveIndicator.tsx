/**
 * The per-tab save chip (🔒 YAZ-1810): the dot-plus-label idiom `SyncIndicator` shares, in the
 * engine's own top-right slot. A `role="status"` region, because "Saving… → Saved" is news the
 * user did not ask for; both chips are styled in `statusChips.css`.
 */
import type { SaveStatus } from '../lib/autosave'

const LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved',
  saving: 'Saving…',
  error: 'Save failed',
}

export function SaveIndicator({ status }: { status: SaveStatus }) {
  return (
    <div className={`save-indicator save-indicator--${status}`} role="status" aria-live="polite">
      <span className="save-indicator__dot" />
      {LABEL[status]}
    </div>
  )
}
