import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The auth context and the two route guards.
 *
 * axios and Firebase are both mocked: what is under test is the decision logic —
 * who counts as signed in, what a non-reviewer sees, and what a 401 does — none
 * of which should need a network or a Google service account to verify.
 */

// Must be declared before the factory below runs.
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockDelete = jest.fn();
let capturedUnauthorizedHandler = null;

jest.mock('../api/client', () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
    patch: (...args) => mockPatch(...args),
    delete: (...args) => mockDelete(...args),
  },
  setUnauthorizedHandler: (handler) => { capturedUnauthorizedHandler = handler; },
}));

jest.mock('../firebase', () => ({ auth: {} }));
jest.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signOut: jest.fn(() => Promise.resolve()),
}));

const { AuthProvider, useAuth } = require('./AuthContext');
const RequireAuth = require('./RequireAuth').default;
const RequireReviewer = require('./RequireReviewer').default;

const USER = { id: 'u1', display_name: 'Ada Lovelace', role: 'user', provider: 'firebase', orcid: '' };
const REVIEWER = { id: 'u2', display_name: 'Grace Hopper', role: 'reviewer', provider: 'orcid', orcid: '0000-0001' };

const unauthorized = () => {
  const err = new Error('Unauthorized');
  err.response = { status: 401, data: { error: { code: 'AUTH_REQUIRED' } } };
  return err;
};

const Probe = () => {
  const { user, loading } = useAuth();
  if (loading) return <p>loading</p>;
  return <p>{user ? `signed in as ${user.display_name} (${user.role})` : 'signed out'}</p>;
};

const renderAt = (initial, element) => render(
  <AuthProvider>
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/login" element={<p>sign-in screen</p>} />
        <Route path="/map" element={<p>the map</p>} />
        <Route path={initial} element={element} />
      </Routes>
    </MemoryRouter>
  </AuthProvider>
);

beforeEach(() => {
  jest.clearAllMocks();
  capturedUnauthorizedHandler = null;
  // CRA's jest config sets resetMocks: true, which strips implementations
  // between tests — so the Firebase stubs are re-armed here rather than in the
  // module factory, where they would only survive the first test.
  const firebase = require('firebase/auth');
  firebase.signOut.mockResolvedValue(undefined);
  firebase.signInWithEmailAndPassword.mockResolvedValue({
    user: { getIdToken: async () => 'id-token' },
  });
  firebase.createUserWithEmailAndPassword.mockResolvedValue({
    user: { getIdToken: async () => 'id-token' },
  });
});

describe('the session comes from the server', () => {
  it('reads GET /api/auth/me once on mount', async () => {
    mockGet.mockResolvedValue({ data: { user: USER } });
    render(<AuthProvider><Probe /></AuthProvider>);

    await screen.findByText('signed in as Ada Lovelace (user)');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/api/auth/me');
  });

  it('treats a 401 from /api/auth/me as signed out, not as an error', async () => {
    mockGet.mockRejectedValue(unauthorized());
    render(<AuthProvider><Probe /></AuthProvider>);

    await screen.findByText('signed out');
  });

  it('reports an ORCID reviewer as signed in, with no Firebase state involved', async () => {
    // The old ProtectedRoute asked Firebase, which knows nothing about ORCID and
    // would have called this reviewer signed out.
    mockGet.mockResolvedValue({ data: { user: REVIEWER } });
    render(<AuthProvider><Probe /></AuthProvider>);

    await screen.findByText('signed in as Grace Hopper (reviewer)');
  });

  /**
   * index.js wraps the app in <React.StrictMode>, which in development mounts,
   * unmounts and remounts every component once. A provider that only clears its
   * "am I mounted" flag on unmount never restores it, so `loading` never
   * clears and the navbar shows its placeholder instead of the account controls
   * — permanently, and only in the real app.
   *
   * The other tests here render without StrictMode and cannot see this, which is
   * exactly how it shipped the first time.
   */
  it('finishes loading under StrictMode, not just under a plain render', async () => {
    mockGet.mockResolvedValue({ data: { user: USER } });
    render(
      <React.StrictMode>
        <AuthProvider><Probe /></AuthProvider>
      </React.StrictMode>
    );

    await screen.findByText('signed in as Ada Lovelace (user)');
    expect(screen.queryByText('loading')).not.toBeInTheDocument();
  });

  it('reaches the signed-out state under StrictMode too', async () => {
    mockGet.mockRejectedValue(unauthorized());
    render(
      <React.StrictMode>
        <AuthProvider><Probe /></AuthProvider>
      </React.StrictMode>
    );

    await screen.findByText('signed out');
  });

  it('drops the user when the client reports a 401 from elsewhere', async () => {
    mockGet.mockResolvedValue({ data: { user: USER } });
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText('signed in as Ada Lovelace (user)');

    // What the axios interceptor does when a session expires mid-visit.
    expect(typeof capturedUnauthorizedHandler).toBe('function');
    act(() => { capturedUnauthorizedHandler(); });

    await screen.findByText('signed out');
    // And it does not re-fetch in a loop.
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe('RequireAuth', () => {
  it('does not render children while the session is unknown', async () => {
    let resolve;
    mockGet.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderAt('/secret', <RequireAuth><p>secret content</p></RequireAuth>);

    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    expect(screen.getByText('Checking your session…')).toBeInTheDocument();

    resolve({ data: { user: USER } });
    await screen.findByText('secret content');
  });

  it('redirects a signed-out visitor to the sign-in screen', async () => {
    mockGet.mockRejectedValue(unauthorized());
    renderAt('/secret', <RequireAuth><p>secret content</p></RequireAuth>);

    await screen.findByText('sign-in screen');
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
  });

  it('renders children for a signed-in user', async () => {
    mockGet.mockResolvedValue({ data: { user: USER } });
    renderAt('/secret', <RequireAuth><p>secret content</p></RequireAuth>);

    await screen.findByText('secret content');
  });
});

describe('RequireReviewer', () => {
  it('explains itself to a signed-in contributor instead of redirecting', async () => {
    mockGet.mockResolvedValue({ data: { user: USER } });
    renderAt('/review', <RequireReviewer><p>review queue</p></RequireReviewer>);

    // Bouncing an authenticated user to a login screen tells them to fix a
    // problem they do not have.
    await screen.findByText('This area is for peer reviewers');
    expect(screen.queryByText('sign-in screen')).not.toBeInTheDocument();
    expect(screen.queryByText('review queue')).not.toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('does send a signed-out visitor to sign in', async () => {
    mockGet.mockRejectedValue(unauthorized());
    renderAt('/review', <RequireReviewer><p>review queue</p></RequireReviewer>);

    await screen.findByText('sign-in screen');
  });

  it('renders children for a reviewer', async () => {
    mockGet.mockResolvedValue({ data: { user: REVIEWER } });
    renderAt('/review', <RequireReviewer><p>review queue</p></RequireReviewer>);

    await screen.findByText('review queue');
  });
});

describe('sign out', () => {
  it('clears the server session and the Firebase one', async () => {
    const { signOut: firebaseSignOut } = require('firebase/auth');
    mockGet.mockResolvedValue({ data: { user: USER } });
    mockDelete.mockResolvedValue({ data: { signed_out: true } });

    const Trigger = () => {
      const { user, signOut } = useAuth();
      return (
        <button type="button" onClick={signOut}>
          {user ? 'signed in' : 'signed out'}
        </button>
      );
    };
    render(<AuthProvider><Trigger /></AuthProvider>);
    await screen.findByText('signed in');

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/api/auth/session'));
    // Skipping the Firebase half leaves a live client session that can quietly
    // mint a fresh server one on the next visit. It happens in signOut's finally
    // block, so it lands a tick after the DELETE resolves.
    await waitFor(() => expect(firebaseSignOut).toHaveBeenCalled());
    await screen.findByText('signed out');
  });
});
