// const neo4j = require('neo4j-driver');
// require('dotenv').config();

// const URI      = process.env.NEO4J_URI;
// const USER     = process.env.NEO4J_USER;
// const PASSWORD = process.env.NEO4J_PASSWORD;

// async function setupDatabase() {
//     const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
//     const session = driver.session();

//     try {
//         await driver.verifyConnectivity();
//         console.log('Connected to Neo4j successfully');

//         // ── CONSTRAINTS ──────────────────────────────────────────────────
//         // Block name must be unique — MERGE key for all block operations
//         await session.run(`
//             CREATE CONSTRAINT block_name_unique IF NOT EXISTS
//             FOR (b:Block) REQUIRE b.name IS UNIQUE
//         `);
//         console.log('✓ Constraint: Block.name unique');

//         // Reference author+year combination must be unique
//         // Two properties together form the identity of a reference
//         await session.run(`
//             CREATE CONSTRAINT reference_unique IF NOT EXISTS
//             FOR (r:Reference) REQUIRE (r.author, r.year) IS NODE KEY
//         `);
//         console.log('✓ Constraint: Reference (author, year) node key');

//         // Link source+target+ltype+maps must be unique
//         // Prevents duplicate links between the same two blocks
//         await session.run(`
//             CREATE CONSTRAINT link_unique IF NOT EXISTS
//             FOR (l:Link) REQUIRE (l.source, l.target, l.ltype, l.maps) IS NODE KEY
//         `);
//         console.log('✓ Constraint: Link (source, target, ltype, maps) node key');

//         // Challenge name must be unique
//         await session.run(`
//             CREATE CONSTRAINT challenge_name_unique IF NOT EXISTS
//             FOR (c:Challenge) REQUIRE c.name IS UNIQUE
//         `);
//         console.log('✓ Constraint: Challenge.name unique');

//         // ── INDEXES ───────────────────────────────────────────────────────
//         // Level index — used by the map rendering and level filter
//         await session.run(`
//             CREATE INDEX block_level IF NOT EXISTS
//             FOR (b:Block) ON (b.level)
//         `);
//         console.log('✓ Index: Block.level');

//         // Approach index — used by the approach/color filter
//         await session.run(`
//             CREATE INDEX block_approach IF NOT EXISTS
//             FOR (b:Block) ON (b.related_approach)
//         `);
//         console.log('✓ Index: Block.related_approach');

//         // Status index — used to filter approved vs pending nodes
//         await session.run(`
//             CREATE INDEX block_status IF NOT EXISTS
//             FOR (b:Block) ON (b.status)
//         `);
//         console.log('✓ Index: Block.status');

//         await session.run(`
//             CREATE INDEX link_status IF NOT EXISTS
//             FOR (l:Link) ON (l.status)
//         `);
//         console.log('✓ Index: Link.status');

//         await session.run(`
//             CREATE INDEX reference_author IF NOT EXISTS
//             FOR (r:Reference) ON (r.author)
//         `);
//         console.log('✓ Index: Reference.author');

//         await session.run(`
//             CREATE INDEX challenge_status IF NOT EXISTS
//             FOR (c:Challenge) ON (c.status)
//         `);
//         console.log('✓ Index: Challenge.status');

//         console.log('\nDatabase setup complete.');

//     } catch (error) {
//         console.error('Setup failed:', error);
//         throw error;
//     } finally {
//         await session.close();
//         await driver.close();
//     }
// }

// setupDatabase();
const neo4j = require('neo4j-driver');
require('dotenv').config();

const URI      = process.env.NEO4J_URI;
const USER     = process.env.NEO4J_USER;
const PASSWORD = process.env.NEO4J_PASSWORD;

async function setupDatabase() {
    const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
    const session = driver.session();

    try {
        await driver.verifyConnectivity();
        console.log('Connected to Neo4j successfully');

        // ── DROP OLD CONSTRAINTS (if they exist from a previous schema version) ──
        // Two reasons a drop is needed before create:
        //
        // 1. link_unique was once keyed on (source, target, ltype, maps) with maps
        //    as a scalar. The new schema keys Link on (source, target, ltype) only,
        //    with maps as an aggregated array property.
        // 2. reference_unique and link_unique were both created as IS NODE KEY,
        //    which is an Enterprise Edition feature. They succeed on Neo4j Desktop
        //    only because it bundles an Enterprise developer licence;
        //    docker-compose.yml pins neo4j:5.19-community, where both statements
        //    fail outright. They are recreated below as composite uniqueness
        //    constraints, which Community supports.
        //
        // Same names, different definitions — a constraint cannot be redefined in
        // place, so drop first.
        for (const name of ['link_unique', 'reference_unique']) {
            try {
                await session.run(`DROP CONSTRAINT ${name} IF EXISTS`);
                console.log(`✓ Dropped old ${name} constraint (if it existed)`);
            } catch (err) {
                console.warn(`  (no old ${name} to drop, or drop failed — continuing)`, err.message);
            }
        }

        // ── CONSTRAINTS ──────────────────────────────────────────────────
        await session.run(`
            CREATE CONSTRAINT block_name_unique IF NOT EXISTS
            FOR (b:Block) REQUIRE b.name IS UNIQUE
        `);
        console.log('✓ Constraint: Block.name unique');

        // ── COMMUNITY-EDITION TRADE-OFF ──────────────────────────────────
        // These two were IS NODE KEY, which is Enterprise-only. Composite
        // uniqueness is the Community-compatible equivalent, but it is strictly
        // weaker: a node key also guarantees the keyed properties EXIST and are
        // non-null, whereas a uniqueness constraint permits a node with a null
        // property (nulls are simply not compared).
        //
        // Consequence: nothing at the database level stops a Reference without an
        // author, or a Link without a target, from being created. The write
        // endpoints must therefore null-check these properties explicitly before
        // writing. Do not remove those checks on the assumption that the schema
        // enforces them; on Community Edition it does not.
        //
        // The same applies to every app-layer constraint added further down:
        // AppUser(provider, provider_uid) is composite IS UNIQUE for exactly this
        // reason. IS NODE KEY would be the better fit — an account with a null
        // provider_uid is meaningless — but it is not available to us.
        await session.run(`
            CREATE CONSTRAINT reference_unique IF NOT EXISTS
            FOR (r:Reference) REQUIRE (r.author, r.year) IS UNIQUE
        `);
        console.log('✓ Constraint: Reference (author, year) composite unique');

        // Link identity is now (source, target, ltype) only.
        // maps is an aggregated array property, populated/unioned as different
        // map-sheets contribute references to the same conceptual link.
        await session.run(`
            CREATE CONSTRAINT link_unique IF NOT EXISTS
            FOR (l:Link) REQUIRE (l.source, l.target, l.ltype) IS UNIQUE
        `);
        console.log('✓ Constraint: Link (source, target, ltype) composite unique');

        await session.run(`
            CREATE CONSTRAINT challenge_name_unique IF NOT EXISTS
            FOR (c:Challenge) REQUIRE c.name IS UNIQUE
        `);
        console.log('✓ Constraint: Challenge.name unique');

        // Map is the registry of cartographies. It exists so a new one can be
        // proposed, reviewed and approved through the application instead of by
        // editing services/filters.js and redeploying — which is what a bare
        // string constant forced.
        //
        // ── Map.code IS IMMUTABLE ONCE APPROVED ──────────────────────────────
        // The code is not just this node's key. It is duplicated into thousands
        // of array entries across three properties — Block.maps, Link.maps and
        // SUPPORTED_BY.maps — none of which any foreign key ties back here.
        // Changing it means rewriting every one of those entries in a single
        // transaction or the graph silently splits in two, exactly as renaming a
        // Block does. The write endpoint must reject a code change on an approved
        // map; the label and description stay freely editable.
        //
        // The registry/array split is a deliberate denormalisation — see the
        // header of services/mapRegistry.js — and assertMapCodesKnown() in
        // populate-database.js is the guard that keeps the two in step.
        await session.run(`
            CREATE CONSTRAINT map_code_unique IF NOT EXISTS
            FOR (m:Map) REQUIRE m.code IS UNIQUE
        `);
        console.log('✓ Constraint: Map.code unique');

        // ── THE REVIEWABLE UNIT ───────────────────────────────────────────
        // A Submission groups everything one proposal created — a Link, the
        // References supporting it and the SUPPORTED_BY edges between them — so
        // that they are approved, rejected, sent back, edited and withdrawn
        // together. Approving a link while rejecting its evidence would publish
        // an "expressly cited" connection with nothing citing it.
        //
        // ── MEMBERSHIP IS A PROPERTY, NOT A RELATIONSHIP ─────────────────────
        // Every node AND relationship a submission creates carries
        // `submission_id`. There is deliberately no (:Submission)-[:INCLUDES]->
        // edge: two of the seven artefact types ARE relationships, and a
        // relationship cannot be the endpoint of another relationship. One
        // mechanism covering all seven beats a structural one covering five.
        //
        // ── submission_id IS ABSENT ON SPREADSHEET CONTENT, DELIBERATELY ─────
        // Nothing loaded by populate-database.js was submitted by anyone, so no
        // id was invented for it. Reads coalesce it to ''. Do not add a
        // migration stamping the existing 198 blocks / 284 links / 126
        // references / 14 challenges / 3 maps: an id that names no submission
        // makes `MATCH (n {submission_id: x})` look meaningful when it is not.
        //
        // UNIQUE, not NODE KEY, for the same Community-Edition reason as above —
        // so a Submission with a null submission_id is not prevented by the
        // schema. services/submissions.js always sets it.
        await session.run(`
            CREATE CONSTRAINT submission_id_unique IF NOT EXISTS
            FOR (s:Submission) REQUIRE s.submission_id IS UNIQUE
        `);
        console.log('✓ Constraint: Submission.submission_id unique');

        // ── APP-LAYER CONSTRAINTS ─────────────────────────────────────────
        // AppUser, Rating, Comment and Tag hold contributed content: accounts,
        // ratings, comments and the folksonomy tier of tagging. They are not part
        // of the research data model the cartographies describe — nothing in this
        // group is populated from the spreadsheet.

        // id is the public identifier, a generated UUID. The provider's own
        // subject identifier is deliberately NOT the primary key: a user can hold
        // both a Firebase and an ORCID identity, and the public id must not change
        // if the provider does.
        await session.run(`
            CREATE CONSTRAINT appuser_id_unique IF NOT EXISTS
            FOR (u:AppUser) REQUIRE u.id IS UNIQUE
        `);
        console.log('✓ Constraint: AppUser.id unique');

        // One account per provider identity. Without this, two sign-ins racing on
        // a first login create two AppUser nodes for the same person, and each
        // subsequent request picks one of them arbitrarily.
        await session.run(`
            CREATE CONSTRAINT appuser_provider_identity_unique IF NOT EXISTS
            FOR (u:AppUser) REQUIRE (u.provider, u.provider_uid) IS UNIQUE
        `);
        console.log('✓ Constraint: AppUser (provider, provider_uid) composite unique');

        await session.run(`
            CREATE CONSTRAINT rating_id_unique IF NOT EXISTS
            FOR (rt:Rating) REQUIRE rt.id IS UNIQUE
        `);
        console.log('✓ Constraint: Rating.id unique');

        await session.run(`
            CREATE CONSTRAINT comment_id_unique IF NOT EXISTS
            FOR (cm:Comment) REQUIRE cm.id IS UNIQUE
        `);
        console.log('✓ Constraint: Comment.id unique');

        // ── THE ONE NODE TYPE HERE WITHOUT A NATURAL KEY ────────────────────
        // Every other label in this schema is keyed by something the research
        // data already provides: Block.name, Reference (author, year), Link
        // (source, target, ltype), Challenge.name, Map.code. A Description has
        // nothing of the sort — its prose is not an identifier, and its block is
        // not its identity either, because "one description per block" is a
        // convention the seed and the detail query keep, not a rule the schema
        // enforces. So the key is a generated UUID, and this constrains that.
        //
        // One consequence worth being explicit about: unlike a MERGE on
        // Block.name, a MERGE on Description.id cannot deduplicate anything —
        // two descriptions written for the same block get two different ids and
        // both persist. seed-descriptions.js therefore MERGEs on the
        // (:Block)-[:HAS_DESCRIPTION]->(:Description) PATH, exactly as the
        // rating rule further down does, and never on the node alone.
        await session.run(`
            CREATE CONSTRAINT description_id_unique IF NOT EXISTS
            FOR (d:Description) REQUIRE d.id IS UNIQUE
        `);
        console.log('✓ Constraint: Description.id unique');

        // Tag names are lower-cased and trimmed before writing, so 'Agile' and
        // 'agile ' collapse to one node and one count. Neo4j uniqueness is
        // case-SENSITIVE — the normalisation is the write endpoint's job, and this
        // constraint only catches what it lets through.
        await session.run(`
            CREATE CONSTRAINT tag_name_unique IF NOT EXISTS
            FOR (t:Tag) REQUIRE t.name IS UNIQUE
        `);
        console.log('✓ Constraint: Tag.name unique');

        // ── NOT ENFORCEABLE AS A CONSTRAINT: one rating per user per block ──
        // The rule is "at most one (:AppUser)-[:RATED]->(:Rating)-[:RATES]->(:Block)
        // path per (user, block) pair". That is a property of a PATH, and Neo4j
        // constrains properties of a single node or relationship only — there is
        // no Community or Enterprise syntax that expresses it, node key included.
        //
        // It is therefore enforced in the write endpoint, by MERGE-ing on the
        // whole path rather than creating a Rating node first:
        //
        //     MATCH (u:AppUser {id: $userId}), (b:Block {name: $block})
        //     MERGE (u)-[:RATED]->(rt:Rating)-[:RATES]->(b)
        //     ON CREATE SET rt.id = $newId, rt.created_at = datetime()
        //     SET rt.efficacy = $efficacy, ... , rt.updated_at = datetime()
        //
        // Do not replace that MERGE with CREATE on the assumption the schema
        // rejects a duplicate. It does not, and duplicates would silently skew
        // every per-block average.
        //
        // The four Rating scores are typed Integer, and the driver packs a bare
        // JavaScript number as a FLOAT — `{efficacy: 4}` stores 4.0, not 4. Pass
        // them as neo4j.int(n), leaving an unanswered score as null.
        //
        // The same gap applies to (:AppUser)-[:TAGGED]->(:Tag)-[:ON]->(:Block) and
        // to (:AppUser)-[:FOUND_HELPFUL]->(:Comment); both are also MERGE-on-path.

        // ── NOT INDEXABLE OR CONSTRAINABLE: review state on a relationship ──
        // Two relationships now carry review state, because the assertion they
        // make is the thing that needs reviewing:
        //
        //     (:Link)-[:SUPPORTED_BY { asterisk, grey, maps[],
        //                              status, created_by, created_at }]->(:Reference)
        //     (:Challenge)-[:SOLVED_BY { status, created_by, created_at }]->(:Block)
        //     (:Map)-[:SOURCED_FROM { status, created_by, created_at,
        //                             submission_id }]->(:Reference)
        //
        // Neo4j Community indexes and constrains NODE properties. Relationship
        // property indexes are an Enterprise feature, and there is no uniqueness
        // constraint for a relationship in any edition — so none of the following
        // is enforced by the schema and all of it is enforced in the write
        // endpoints instead:
        //
        //   - `status` is not constrained to the four values in
        //     services/proposals.js STATUSES. A typo writes a status that every
        //     read filter then misses, and the edge silently disappears from the
        //     map rather than erroring.
        //   - At most one SUPPORTED_BY per (link, reference) pair, and one
        //     SOLVED_BY per (challenge, block) pair, is not expressible. Both
        //     write paths therefore check for an existing edge and answer 409;
        //     do not replace those checks with CREATE on the assumption the
        //     schema rejects a duplicate. It does not, and a duplicate edge
        //     double-counts in Link.reference_count and renders the citation
        //     twice.
        //   - There is no index on `status`, so every read filtering on it scans
        //     the relationships it has already traversed. That is fine at 344 and
        //     48 edges and is worth revisiting if either grows by orders of
        //     magnitude.
        //
        // Do NOT "fix" this by moving the status onto the Reference or Challenge
        // node. The node's status answers "is this paper in the bibliography";
        // the edge's answers "does this paper support this connection", and it is
        // the second question a reviewer is being asked. Attaching a real,
        // approved paper to a connection it does not support is the case a node
        // status cannot catch.

        // ── INDEXES ───────────────────────────────────────────────────────
        await session.run(`
            CREATE INDEX block_level IF NOT EXISTS
            FOR (b:Block) ON (b.level)
        `);
        console.log('✓ Index: Block.level');

        await session.run(`
            CREATE INDEX block_approach IF NOT EXISTS
            FOR (b:Block) ON (b.related_approach)
        `);
        console.log('✓ Index: Block.related_approach');

        await session.run(`
            CREATE INDEX block_status IF NOT EXISTS
            FOR (b:Block) ON (b.status)
        `);
        console.log('✓ Index: Block.status');

        await session.run(`
            CREATE INDEX link_status IF NOT EXISTS
            FOR (l:Link) ON (l.status)
        `);
        console.log('✓ Index: Link.status');

        await session.run(`
            CREATE INDEX reference_author IF NOT EXISTS
            FOR (r:Reference) ON (r.author)
        `);
        console.log('✓ Index: Reference.author');

        await session.run(`
            CREATE INDEX challenge_status IF NOT EXISTS
            FOR (c:Challenge) ON (c.status)
        `);
        console.log('✓ Index: Challenge.status');

        // Reference is the last reviewable type to gain a status, so it is the
        // last to gain the index every review queue reads.
        await session.run(`
            CREATE INDEX reference_status IF NOT EXISTS
            FOR (r:Reference) ON (r.status)
        `);
        console.log('✓ Index: Reference.status');

        // Read on every registry load — the only query the Map node serves.
        await session.run(`
            CREATE INDEX map_status IF NOT EXISTS
            FOR (m:Map) ON (m.status)
        `);
        console.log('✓ Index: Map.status');

        // The review queue reads Submission by status; "my submissions" reads it
        // by created_by. Both on every load of their respective pages.
        await session.run(`
            CREATE INDEX submission_status IF NOT EXISTS
            FOR (s:Submission) ON (s.status)
        `);
        console.log('✓ Index: Submission.status');

        await session.run(`
            CREATE INDEX submission_created_by IF NOT EXISTS
            FOR (s:Submission) ON (s.created_by)
        `);
        console.log('✓ Index: Submission.created_by');

        // Resolving a submission's members is one lookup per artefact type on
        // `submission_id`. Without these, each is a label scan — 284 links and
        // 126 references today, and every approve, reject, edit and withdrawal
        // does seven of them.
        //
        // NOT INDEXABLE: the same property on SUPPORTED_BY and SOLVED_BY.
        // Relationship property indexes are an Enterprise feature and
        // docker-compose.yml pins neo4j:5.19-community, so those two lookups
        // scan the 344 and 48 edges. Fine at this size; revisit if either grows
        // by orders of magnitude, and note that the fix is an edition change,
        // not a query change.
        for (const [name, label] of [
            ['block_submission', 'Block'],
            ['link_submission', 'Link'],
            ['reference_submission', 'Reference'],
            ['challenge_submission', 'Challenge'],
            ['map_submission', 'Map'],
        ]) {
            await session.run(`
                CREATE INDEX ${name} IF NOT EXISTS
                FOR (n:${label}) ON (n.submission_id)
            `);
            console.log(`✓ Index: ${label}.submission_id`);
        }

        // ── APP-LAYER INDEXES ─────────────────────────────────────────────
        // Every authorisation check reads role, on every authenticated request.
        await session.run(`
            CREATE INDEX appuser_role IF NOT EXISTS
            FOR (u:AppUser) ON (u.role)
        `);
        console.log('✓ Index: AppUser.role');

        await session.run(`
            CREATE INDEX comment_status IF NOT EXISTS
            FOR (cm:Comment) ON (cm.status)
        `);
        console.log('✓ Index: Comment.status');

        // Descriptions are REVIEWED content — unlike ratings, comments and tags,
        // which publish immediately (see services/community.js for why the two
        // differ). The status is therefore on the hot path: every block detail
        // response filters on it, and the review queue lists by it.
        await session.run(`
            CREATE INDEX description_status IF NOT EXISTS
            FOR (d:Description) ON (d.status)
        `);
        console.log('✓ Index: Description.status');

        // Rating gets no index of its own. It is never looked up by a property:
        // every read arrives through (:AppUser)-[:RATED]->(:Rating) or
        // (:Rating)-[:RATES]->(:Block), and the relationship traversal is the
        // access path. rating_id_unique already backs the one property lookup
        // that exists, by id.

        console.log('\nDatabase setup complete.');

    } catch (error) {
        console.error('Setup failed:', error);
        throw error;
    } finally {
        await session.close();
        await driver.close();
    }
}

setupDatabase();
