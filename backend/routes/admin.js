'use strict';

const express = require('express');
const { asyncHandler, AppError, notFound } = require('../middleware/errorHandler');
const { requireAuth, requireReviewer, writeLimiter } = require('../middleware/auth');
const users = require('../services/users');

const router = express.Router();

// Router-level guard: everything below is reviewer-only by construction, so a
// route added to this file later cannot be reachable by a plain user.
router.use(requireAuth, requireReviewer, writeLimiter);

router.get('/users', asyncHandler(async (req, res) => {
    const list = await users.listUsers();
    res.json({
        users: list.map((u) => ({
            id: u.id, display_name: u.display_name, role: u.role,
            provider: u.provider, orcid: u.orcid, created_at: u.created_at,
            last_seen_at: u.last_seen_at,
        })),
        meta: { counts: { users: list.length } },
    });
}));

/**
 * PATCH /api/admin/users/:id/role — demotion.
 *
 * Promotion is automatic: signing in with ORCID confers 'reviewer'. This route
 * exists for the other direction, so a misbehaving account can be demoted
 * through the API rather than by hand-editing the database — which is the only
 * remedy available otherwise, given that reviewer status is self-service.
 *
 * Setting the role also bumps AppUser.session_version (see services/users.js),
 * which invalidates the demoted account's existing cookies immediately.
 */
router.patch('/users/:id/role', asyncHandler(async (req, res) => {
    const { role } = req.body || {};
    if (!users.ROLES.includes(role)) {
        throw new AppError(422, 'INVALID_ROLE',
            `role must be one of: ${users.ROLES.join(', ')}.`);
    }

    // Self-demotion is refused rather than allowed and regretted: a lone
    // reviewer demoting themselves would leave the instance with nobody able to
    // approve anything and no route back, since promotion only happens at
    // sign-in for ORCID accounts.
    if (req.params.id === req.user.id) {
        throw new AppError(403, 'CANNOT_CHANGE_OWN_ROLE',
            'You cannot change your own role. Ask another reviewer to do it.');
    }

    const target = await users.findUserById(req.params.id);
    if (!target) throw notFound('USER_NOT_FOUND', `No user with id "${req.params.id}".`);

    const updated = await users.setUserRole(req.params.id, role);
    res.json({
        user: {
            id: updated.id, display_name: updated.display_name, role: updated.role,
            provider: updated.provider, orcid: updated.orcid,
        },
        changed_by: req.user.id,
        note: 'Existing sessions for this account have been invalidated.',
    });
}));

module.exports = router;
