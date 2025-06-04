const neo4j = require('neo4j-driver');
require('dotenv').config();

const URI = process.env.NEO4J_URI;
const USER = process.env.NEO4J_USER;
const PASSWORD = process.env.NEO4J_PASSWORD;

const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));

async function setupDatabase() {
    const session = driver.session();
    try {
        // Create constraints for unique node names
        const constraints = [
            'CREATE CONSTRAINT IF NOT EXISTS FOR (n:Product) REQUIRE n.name IS UNIQUE',
            'CREATE CONSTRAINT IF NOT EXISTS FOR (n:Method) REQUIRE n.name IS UNIQUE',
            'CREATE CONSTRAINT IF NOT EXISTS FOR (n:Tool) REQUIRE n.name IS UNIQUE',
            'CREATE CONSTRAINT IF NOT EXISTS FOR (n:Process) REQUIRE n.name IS UNIQUE',
            'CREATE CONSTRAINT IF NOT EXISTS FOR (n:Framework) REQUIRE n.name IS UNIQUE'
        ];

        // Create indexes for better query performance
        const indexes = [
            'CREATE INDEX IF NOT EXISTS FOR (n:Product) ON (n.map)',
            'CREATE INDEX IF NOT EXISTS FOR (n:Method) ON (n.map)',
            'CREATE INDEX IF NOT EXISTS FOR (n:Tool) ON (n.map)',
            'CREATE INDEX IF NOT EXISTS FOR (n:Process) ON (n.map)',
            'CREATE INDEX IF NOT EXISTS FOR (n:Framework) ON (n.map)'
        ];

        // Execute constraints one by one
        for (const constraint of constraints) {
            await session.run(constraint);
            console.log(`Executed constraint: ${constraint}`);
        }

        // Execute indexes one by one
        for (const index of indexes) {
            await session.run(index);
            console.log(`Executed index: ${index}`);
        }

        console.log('Database schema setup completed successfully!');
    } catch (error) {
        console.error('Error setting up database schema:', error);
    } finally {
        await session.close();
        await driver.close();
    }
}

setupDatabase(); 