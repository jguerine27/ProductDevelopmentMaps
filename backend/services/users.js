'use strict';

const crypto = require('node:crypto');
const { getReadSession, getWriteSession, recordToObject } = require('../db');

/**
 * AppUser reads and writes.
 *
 * ── WHAT IS DELIBERATELY NOT STORED ──────────────────────────────────────────
 * No email: the identity provider holds it, and copying it here would duplicate
 * personal data into a second system for no functional gain. No IP address, no
 * user agent, no analytics. These are data-minimisation decisions under Quebec
 * Law 25 and GDPR — every field not stored is one that need not be secured,
 * exported or erased. Do not add them back for convenience.
 *
 * ── ROLES ────────────────────────────────────────────────────────────────────
 * ORCID sign-in confers 'reviewer'; Firebase sign-in confers 'user'. ORCID is
 * used precisely because the people who should be reviewing are already
 * identifiable members of the research community, and making an administrator
 * vet each one would stall contribution before it started.
 *
 * The gate is weaker than it looks: ORCID registration is free, self-service and
 * needs no institutional affiliation. Two things compensate, and both are
 * load-bearing rather than decorative:
 *
 *   1. The role field and PATCH /api/admin/users/:id/role survive, so a
 *      misbehaving account is demoted through the API instead of by hand-editing
 *      the database. Promotion is automatic at sign-in; that route exists for the
 *      other direction.
 *   2. Every approval records approved_by/approved_at (and rejected_by/
 *      rejected_at). With reviewer status ungated, the audit trail is what makes
 *      a bad approval traceable and reversible.
 */

const ROLES = Object.freeze(['user', 'reviewer']);
const PROVIDERS = Object.freeze(['firebase', 'orcid']);

/** The sentinel left behind by DELETE /api/auth/me. Never a real AppUser.id. */
const DELETED_USER = 'deleted-user';

const USER_RETURN = `
    u.id              AS id,
    u.provider        AS provider,
    u.provider_uid    AS provider_uid,
    u.display_name    AS display_name,
    coalesce(u.orcid, '')            AS orcid,
    u.role            AS role,
    coalesce(u.session_version, 0)   AS session_version,
    toString(u.created_at)           AS created_at,
    toString(u.last_seen_at)         AS last_seen_at,
    coalesce(u.consent_version, '')  AS consent_version,
    toString(u.consent_at)           AS consent_at
`;

/**
 * Find-or-create the account behind a verified provider identity.
 *
 * MERGE on (provider, provider_uid), which is the composite-unique pair — not on
 * id, which is ours to mint. Two sign-ins racing on a first login therefore
 * converge on one node instead of creating two accounts for the same person.
 *
 * On a repeat sign-in the role is NOT rewritten. Re-asserting 'reviewer' on
 * every ORCID login would silently undo a demotion the moment the demoted
 * account signed back in, which is the one thing the demotion route must not
 * allow. The role is set once, at account creation.
 */
async function upsertUser({ provider, providerUid, displayName, orcid = '', role, consentVersion = '' }) {
    if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
    if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
    if (!providerUid) throw new Error('providerUid is required');

    const session = getWriteSession();
    try {
        const result = await session.executeWrite((tx) => tx.run(`
            MERGE (u:AppUser {provider: $provider, provider_uid: $providerUid})
            ON CREATE SET
                u.id              = $newId,
                u.role            = $role,
                u.created_at      = datetime(),
                u.session_version = 0,
                u.consent_version = $consentVersion,
                u.consent_at      = datetime()
            SET u.display_name = $displayName,
                u.orcid        = $orcid,
                u.last_seen_at = datetime()
            RETURN ${USER_RETURN}
        `, {
            provider,
            providerUid,
            newId: crypto.randomUUID(),
            role,
            displayName: displayName || 'Anonymous',
            orcid: orcid || '',
            consentVersion,
        }));
        return recordToObject(result.records[0]);
    } finally {
        await session.close();
    }
}

/** Used by attachUser on every authenticated request — the role is read here. */
async function findUserById(id) {
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) =>
            tx.run(`MATCH (u:AppUser {id: $id}) RETURN ${USER_RETURN}`, { id }));
        return result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
}

async function updateDisplayName(id, displayName) {
    const session = getWriteSession();
    try {
        const result = await session.executeWrite((tx) => tx.run(`
            MATCH (u:AppUser {id: $id})
            SET u.display_name = $displayName
            RETURN ${USER_RETURN}
        `, { id, displayName }));
        return result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
}

/**
 * Change a role, and invalidate that user's existing sessions.
 *
 * Bumping session_version is the whole point: without it a demoted reviewer
 * keeps whatever their current cookie asserts until it expires. The role itself
 * is re-read per request, so the bump is belt-and-braces — it also forces a
 * fresh sign-in, which is the visible signal a demotion should carry.
 */
async function setUserRole(id, role) {
    if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
    const session = getWriteSession();
    try {
        const result = await session.executeWrite((tx) => tx.run(`
            MATCH (u:AppUser {id: $id})
            SET u.role = $role,
                u.session_version = coalesce(u.session_version, 0) + 1
            RETURN ${USER_RETURN}
        `, { id, role }));
        return result.records.length ? recordToObject(result.records[0]) : null;
    } finally {
        await session.close();
    }
}

async function listUsers() {
    const session = getReadSession();
    try {
        const result = await session.executeRead((tx) =>
            tx.run(`MATCH (u:AppUser) RETURN ${USER_RETURN} ORDER BY u.created_at`));
        return result.records.map(recordToObject);
    } finally {
        await session.close();
    }
}

module.exports = {
    ROLES,
    PROVIDERS,
    DELETED_USER,
    upsertUser,
    findUserById,
    updateDisplayName,
    setUserRole,
    listUsers,
};
