import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Set before first paint so the CSS that reserves space for macOS's
// traffic-light window buttons (see .top-bar in index.css) is correct
// from the very first frame, no flash.
document.documentElement.dataset.platform = window.deltaBridge?.platform || ''

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
