import { useEffect, useRef, useState } from 'react'
import Delta from '../api/DeltaAPI.js'

// One field from a section's declarative `fields` array - see
// PluginSettingsSection's own doc comment below for the two supported
// shapes. Keeps its own local value (seeded from field.value ?? field.default)
// and just calls field.onChange(parsed) whenever it changes - the plugin
// itself owns actually storing that value anywhere.
function SettingsField({ field }) {
  const initial = field.value ?? field.default ?? (field.type === 'boolean' ? false : '')
  const [value, setValue] = useState(initial)

  function commit(raw) {
    const parsed = field.type === 'number' ? (raw === '' ? null : Number(raw)) : raw
    setValue(parsed)
    // `field` is the exact object the plugin passed into
    // registerSettingsSection()'s `fields` array - registerSettingsSection()
    // doesn't clone it, so writing back onto it here isn't just local
    // React state. Without this, a Settings screen remount (switching
    // tabs away and back fully unmounts it, same as every other screen -
    // see App.jsx) re-seeds `initial` from field.value ?? field.default
    // above - and since field.value was never updated, that always fell
    // back to `default`, silently reverting the toggle/input to its
    // starting value even though the plugin's own onChange had already
    // recorded the real one.
    field.value = parsed
    try {
      field.onChange?.(parsed)
    } catch (err) {
      console.error(`[Delta] settings field "${field.key}" onChange failed:`, err)
    }
  }

  return (
    <label className="settings-field">
      <span className="settings-field-label">{field.label || field.key}</span>
      {field.type === 'boolean' ? (
        <input type="checkbox" checked={!!value} onChange={(e) => commit(e.target.checked)} />
      ) : field.type === 'select' && Array.isArray(field.options) ? (
        <select className="settings-field-input" value={value ?? ''} onChange={(e) => commit(e.target.value)}>
          {field.options.map((opt) => {
            const optValue = typeof opt === 'object' ? opt.value : opt
            const optLabel = typeof opt === 'object' ? opt.label : opt
            return (
              <option key={optValue} value={optValue}>
                {optLabel}
              </option>
            )
          })}
        </select>
      ) : (
        <input
          className="settings-field-input"
          type={field.type === 'number' ? 'number' : 'text'}
          value={value ?? ''}
          onChange={(e) => commit(e.target.value)}
        />
      )}
    </label>
  )
}

/**
 * Hosts one `Delta.registerSettingsSection()` entry inside the Settings
 * screen. `section` can supply either (or both) of:
 *
 *  - `render(container, api)` - plain-DOM builder for anything custom;
 *    plugins are bundler-free JS with no JSX to hand back, so this gets
 *    an empty <div> to build into directly instead, the same way a
 *    toolbar button's onClick gets a raw callback rather than a
 *    component. May return a cleanup function.
 *  - `fields: [{ key, label, type: 'text'|'number'|'boolean'|'select',
 *    default, options?, onChange(value) }]` - a declarative list of
 *    labelled inputs, for the common case of "a few settings values,
 *    each with its own onChange" - no DOM code needed at all. This is
 *    the shape most plugin settings actually turn out to need.
 */
export default function PluginSettingsSection({ section }) {
  const containerRef = useRef(null)
  const hasRender = typeof section.render === 'function'
  const hasFields = Array.isArray(section.fields) && section.fields.length > 0

  useEffect(() => {
    const el = containerRef.current
    if (!el || !hasRender) return
    el.innerHTML = ''
    let cleanup
    try {
      cleanup = section.render(el, Delta)
    } catch (err) {
      console.error(`[Delta] settings section "${section.id}" failed to render:`, err)
    }
    return () => {
      if (typeof cleanup === 'function') {
        try {
          cleanup()
        } catch (err) {
          console.error(`[Delta] settings section "${section.id}" cleanup failed:`, err)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, hasRender])

  return (
    <section className="settings-section">
      {section.title && <h2>{section.title}</h2>}
      {hasRender && <div ref={containerRef} className="settings-section-plugin-body" />}
      {hasFields && (
        <div className="settings-fields">
          {section.fields.map((field) => (
            <SettingsField key={field.key} field={field} />
          ))}
        </div>
      )}
    </section>
  )
}
