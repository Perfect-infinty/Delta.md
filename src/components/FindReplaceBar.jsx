import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import CloseIcon from '@mui/icons-material/Close'

/**
 * A plain-text (no regex) find & replace bar for the note editor.
 * Operates directly on the textarea's own selection, so "next match"
 * is just the browser's native text-selection highlight - no separate
 * overlay/highlighting layer needed.
 */
// Props: the two query strings + their change handlers, the match counter
// (`matchIndex` is 0-based, shown 1-based), next/prev/replace callbacks that
// the editor implements against its textarea, and `inputRef` so the editor
// can re-focus the Find field when the shortcut is pressed again.
export default function FindReplaceBar({
  findQuery,
  onFindChange,
  replaceQuery,
  onReplaceChange,
  matchCount,
  matchIndex,
  onNext,
  onPrev,
  onReplace,
  onReplaceAll,
  onClose,
  inputRef
}) {
  // Shared by both inputs: Enter = next, Shift+Enter = previous,
  // arrows also step through matches, Escape closes the bar.
  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) onPrev()
      else onNext()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      onNext()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      onPrev()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="find-replace-bar">
      <input
        ref={inputRef}
        className="find-replace-input"
        placeholder="Find"
        value={findQuery}
        onChange={(e) => onFindChange(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <span className="find-replace-count">{matchCount > 0 ? `${matchIndex + 1}/${matchCount}` : '0/0'}</span>
      <button className="icon-btn" type="button" title="Previous match" onClick={onPrev} disabled={matchCount === 0}>
        <ArrowUpwardIcon fontSize="small" />
      </button>
      <button className="icon-btn" type="button" title="Next match" onClick={onNext} disabled={matchCount === 0}>
        <ArrowDownwardIcon fontSize="small" />
      </button>

      <input
        className="find-replace-input"
        placeholder="Replace"
        value={replaceQuery}
        onChange={(e) => onReplaceChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button className="btn btn-ghost" type="button" onClick={onReplace} disabled={matchCount === 0}>
        Replace
      </button>
      <button className="btn btn-ghost" type="button" onClick={onReplaceAll} disabled={matchCount === 0}>
        Replace All
      </button>

      <button className="icon-btn" type="button" title="Close" onClick={onClose}>
        <CloseIcon fontSize="small" />
      </button>
    </div>
  )
}
