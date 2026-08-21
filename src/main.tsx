import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import App from './App';
import { SessionProvider } from './auth/SessionContext';
import { RedirectIfAuthed, RequireAdmin, RequireAuth } from './auth/guards';
import Admin from './pages/Admin';
import Forgot from './pages/Forgot';
import Login from './pages/Login';
import Reset from './pages/Reset';
import Signup from './pages/Signup';
import Verify from './pages/Verify';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          {/* Signed out only: already-authenticated visitors get bounced on,
              honouring ?next= the way the server's /login handler does. */}
          <Route path="/login" element={<RedirectIfAuthed><Login /></RedirectIfAuthed>} />
          <Route path="/signup" element={<RedirectIfAuthed><Signup /></RedirectIfAuthed>} />

          {/* Reachable either way -- both act on a token from an email link. */}
          <Route path="/forgot" element={<Forgot />} />
          <Route path="/reset" element={<Reset />} />
          <Route path="/verify" element={<Verify />} />

          <Route element={<RequireAuth />}>
            <Route path="/" element={<App />} />
          </Route>

          <Route element={<RequireAdmin />}>
            <Route path="/admin" element={<Admin />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
