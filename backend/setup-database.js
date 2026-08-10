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