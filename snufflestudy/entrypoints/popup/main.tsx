import React from 'react';
import ReactDOM from 'react-dom/client';
import { PopupApp } from '../../src/popup/PopupApp';
import './style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>,
);
