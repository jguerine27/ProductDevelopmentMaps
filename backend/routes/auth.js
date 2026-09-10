'use strict';

const express = require('express');
const config = require('../config');
const { asyncHandler, AppError, badRequest } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const session = require('../services/session');
const firebaseAdmin = require('../services/firebaseAdmin');
const orcid = require('../services/orcid');
const users = require('../services/users');
const { exportUserData, eraseUser } = require('../services/dataRights');

const router = express.Router();

/**
 * Sign-in, sign-out, and the caller's own record.
 *
 * Guarding here is per-route rather than router-wide, because this router is
 * genuinely mixed: sign-in must be reachable without a session, and /me must
 * not be. Every OTHER write router guards at the parent — see
 * routes/proposals/index.js and routes/manage/index.js — so this is the one
 * file where the guard is visible on each line, and it is short enough to read.
 */

const MAX_DISPLAY_NAME = 120;

function publicUser(user) {
    return {
        id: user.id,
        display_name: user.display_name,
        role: user.role,
        provider: user.provider,
        orcid: user.orcid || '',
    };
}

// ── Firebase: the 'user' role ────────────────────────────────────────────────
router.post('/session/firebase', asyncHandler(async (req, res) => {
    if (!firebaseAdmin.isConfigured()) {
        throw new AppError(503, 'FIREBASE_NOT_CONFIGURED',
            'Firebase sign-in is not configured on this server.');
    }
    const { idToken } = req.body || {};
    if (typeof idToken !== 'string' || !idToken.trim()) {
        throw badRequest('MISSING_ID_TOKEN', 'Provide the Firebase ID token as { idToken }.');
    }

    let verified;
    try {
        verified = await firebaseAdmin.verifyIdToken(idToken);
    } catch (err) {
        // The reason is logged, not returned: telling a caller why a token
        // failed helps forge the next one.
        console.warn('[auth] Firebase token rejected:', err.message);
        throw new AppError(401, 'INVALID_ID_TOKEN', 'That sign-in could not be verified.');
    }

    const user = await users.upsertUser({
        provider: 'firebase',
        providerUid: verified.uid,
        displayName: verified.name,
        role: 'user',
    });
    session.setSessionCookie(res, user);
    res.json({ user: publicUser(user) });
}));

// ── ORCID: the 'reviewer' role ───────────────────────────────────────────────
router.get('/orcid/start', asyncHandler(async (req, res) => {
    if (!orcid.isConfigured()) {
        throw new AppError(503, 'ORCID_NOT_CONFIGURED',
            'ORCID sign-in is not configured on this server.');
    }
    const state = session.issueStateToken();
    session.setStateCookie(res, state);
    res.redirect(orcid.buildAuthorizeUrl(state));
}));

router.get('/orcid/callback', asyncHandler(async (req, res) => {
    if (!orcid.isConfigured()) {
        throw new AppError(503, 'ORCID_NOT_CONFIGURED',
            'ORCID sign-in is not configured on this server.');
    }

    // The state check comes first, before the code is spent. An
    // authorization-code callback with no CSRF guard lets an attacker deliver
    // their own code to a victim's browser, and the victim silently ends up
    // signed in as the attacker.
    const cookieState = session.readStateCookie(req);
    session.clearStateCookie(res);
    if (!session.stateMatches(cookieState, req.query.state)) {
        throw badRequest('INVALID_OAUTH_STATE',
            'The sign-in request could not be verified. Start again from the sign-in page.');
    }

    const code = req.query.code;
    if (typeof code !== 'string' || !code.trim()) {
        throw badRequest('MISSING_OAUTH_CODE', 'ORCID did not return an authorization code.');
    }

    let identity;
    try {
        identity = await orcid.exchangeCode(code);
    } catch (err) {
        console.warn('[auth] ORCID exchange failed:', err.message);
        throw new AppError(502, 'ORCID_EXCHANGE_FAILED', 'ORCID sign-in could not be completed.');
    }

    // ORCID sign-in confers 'reviewer'. See services/users.js for why the gate
    // is deliberately this weak and what compensates for it.
    const user = await users.upsertUser({
        provider: 'orcid',
        providerUid: identity.orcid,
        displayName: identity.name,
        orcid: identity.orcid,
        role: 'reviewer',
    });
    session.setSessionCookie(res, user);

    // A browser lands here, not a fetch client, so redirect rather than return JSON.
    res.redirect(config.orcid.successRedirect);
}));

router.delete('/session', (req, res) => {
    session.clearSessionCookie(res);
    res.json({ signed_out: true });
});

// ── The caller's own record ──────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
});

router.patch('/me', requireAuth, asyncHandler(async (req, res) => {
    const { display_name: displayName } = req.body || {};
    if (typeof displayName !== 'string' || !displayName.trim()) {
        throw new AppError(422, 'INVALID_DISPLAY_NAME', 'Provide a non-empty { display_name }.');
    }
    if (displayName.length > MAX_DISPLAY_NAME) {
        throw new AppError(422, 'INVALID_DISPLAY_NAME',
            `display_name must be ${MAX_DISPLAY_NAME} characters or fewer.`);
    }
    // req.user.id, never a body field: ownership comes from the session.
    const user = await users.updateDisplayName(req.user.id, displayName.trim());
    res.json({ user: publicUser(user) });
}));

router.get('/me/export', requireAuth, asyncHandler(async (req, res) => {
    const data = await exportUserData(req.user.id);
    res.set('Content-Disposition', 'attachment; filename="my-data.json"');
    res.json(data);
}));

router.delete('/me', requireAuth, asyncHandler(async (req, res) => {
    const summary = await eraseUser(req.user.id);
    session.clearSessionCookie(res);
    res.json({
        erased: true,
        ...summary,
        note: 'Your account has been deleted. Content you contributed remains as map ' +
              'content, and the review record remains intact but no longer names you.',
    });
}));

module.exports = router;
