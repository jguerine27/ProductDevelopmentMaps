const express = require('express');
const neo4j = require('neo4j-driver');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const URI = process.env.NEO4J_URI;
const USER = process.env.NEO4J_USER;
const PASSWORD = process.env.NEO4J_PASSWORD;

let driver;

(async () => {
    try {
        driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
        const serverInfo = await driver.getServerInfo();
        console.log('Connection established');
        console.log(serverInfo);
    } catch (err) {
        console.error(`Connection error\n${err}\nCause: ${err.cause}`);
        if (driver) {
            await driver.close();
        }
        process.exit(1); // Exit the process on connection error
    }
})();

// Fetch all nodes and relationships, including isolated nodes
app.get('/api/nodes-relationships', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(
            `MATCH (n)
            OPTIONAL MATCH (n)-[r]->(m)
            RETURN n, labels(n) as nLabels, r, m, labels(m) as mLabels`
        );

        const nodes = new Map();
        result.records.forEach(record => {
            const startNode = record.get('n').properties;
            const startNodeLabel = record.get('nLabels')[0];
            const endNode = record.get('m') ? record.get('m').properties : null;
            const endNodeLabel = record.get('mLabels') ? record.get('mLabels')[0] : null;
            const relationship = record.get('r') ? record.get('r').properties : null;

            if (!nodes.has(startNode.name)) {
                nodes.set(startNode.name, { ...startNode, label: startNodeLabel });
            }

            if (endNode && !nodes.has(endNode.name)) {
                nodes.set(endNode.name, { ...endNode, label: endNodeLabel });
            }
        });

        const relationships = result.records
            .filter(record => record.get('r'))
            .map(record => ({
                source: record.get('n').properties.name,
                target: record.get('m').properties.name,
                name: record.get('r').properties.name,
                type: record.get('r').properties.type
            }));

        res.json({ nodes: Array.from(nodes.values()), relationships });
    } catch (error) {
        console.error('Error fetching nodes and relationships:', error);
        res.status(500).json({ error: 'Failed to fetch nodes and relationships' });
    } finally {
        await session.close();
    }
});

// Fetch all node labels
app.get('/api/node-labels', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run('CALL db.labels()');
        const labels = result.records.map(record => record.get(0));
        res.json(labels);
    } catch (error) {
        console.error('Error fetching node labels:', error);
        res.status(500).json({ error: 'Failed to fetch node labels' });
    } finally {
        await session.close();
    }
});

// Fetch all unique map names
app.get('/api/node-maps', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(
            'MATCH (n) WHERE n.map IS NOT NULL RETURN DISTINCT n.map AS map'
        );
        const maps = result.records.map(record => record.get('map'));
        res.json(maps);
    } catch (error) {
        console.error('Error fetching map names:', error);
        res.status(500).json({ error: 'Failed to fetch map names' });
    } finally {
        await session.close();
    }
});

// Fetch all node names for a given label
app.get('/api/node-names/:label', async (req, res) => {
    const { label } = req.params;
    const session = driver.session();
    try {
        const result = await session.run(
            `MATCH (n:${label}) RETURN n.name AS name`
        );
        const names = result.records.map(record => record.get('name'));
        res.json(names);
    } catch (error) {
        console.error(`Error fetching node names for label ${label}:`, error);
        res.status(500).json({ error: `Failed to fetch node names for label ${label}` });
    } finally {
        await session.close();
    }
});

// Create a node
app.post('/api/create-node', async (req, res) => {
    const { label, name, type, citations, tags, map, color } = req.body;

    const session = driver.session();

    try {
        // Get the current count of nodes
        const countResult = await session.run(`MATCH (n) RETURN count(n) as count`);
        const count = countResult.records[0].get('count').toInt();
        const newId = count + 1;

        // Create the new node with the auto-incremented ID
        const result = await session.run(
            `CREATE (b:${label} {name: $name, type: $type, citations: $citations, tags: $tags, map: $map, color: $color}) RETURN b`,
            { id: newId, name, type, citations, tags, map, color }
        );

        if (result.records.length > 0) {
            const node = result.records[0].get('b');
            res.status(200).json({ message: 'Node created successfully', node });
        } else {
            res.status(500).json({ error: 'Failed to create node' });
        }
    } catch (error) {
        console.error('Error creating node:', error);
        res.status(500).json({ error: 'An error occurred while creating node' });
    } finally {
        await session.close();
    }
});

// Create a relationship
app.post('/create-relationship', async (req, res) => {
    const { nodeLabel1, nodeName1, nodeLabel2, nodeName2, referenceName, year, author, type } = req.body;

    const session = driver.session();

    try {
        const result = await session.run(
            `
            MATCH (a:${nodeLabel1} {name: $nodeName1}), (b:${nodeLabel2} {name: $nodeName2})
            CREATE (a)-[r:Reference {name: $referenceName, year: $year, author: $author, type: $type}]->(b)
            RETURN r
            `,
            {
                nodeName1,
                nodeName2,
                referenceName,
                year,
                author,
                type
            }
        );

        if (result.records.length > 0) {
            res.status(200).json({ message: 'Reference created successfully' });
        } else {
            res.status(404).json({ message: 'One or both nodes not found' });
        }
    } catch (error) {
        console.error('Error creating reference:', error);
        res.status(500).json({ message: 'An error occurred' });
    } finally {
        await session.close();
    }
});

// Filter nodes by keyword
app.get('/api/filter/keyword/:keyword', async (req, res) => {
    const { keyword } = req.params;
    const session = driver.session();
    try {
        const result = await session.run(
            `MATCH (n)
            WHERE any(prop in keys(n) WHERE toLower(n[prop]) CONTAINS toLower($keyword)) OR any(lbl in labels(n) WHERE toLower(lbl) CONTAINS toLower($keyword))
            RETURN n, labels(n) as nLabels`
            , { keyword }
        );

        const nodes = result.records.map(record => {
            return { ...record.get('n').properties, label: record.get('nLabels')[0] };
        });

        res.json(nodes);
    } catch (error) {
        console.error('Error filtering nodes by keyword:', error);
        res.status(500).json({ error: 'Failed to filter nodes by keyword' });
    } finally {
        await session.close();
    }
});

// Filter nodes by publication date
app.get('/api/filter/date/:date', async (req, res) => {
    const { date } = req.params;
    const session = driver.session();
    try {
        const result = await session.run(
            `MATCH (n)
            WHERE n.publicationDate = $date
            RETURN n, labels(n) as nLabels`
            , { date }
        );

        const nodes = result.records.map(record => {
            return { ...record.get('n').properties, label: record.get('nLabels')[0] };
        });

        res.json(nodes);
    } catch (error) {
        console.error('Error filtering nodes by publication date:', error);
        res.status(500).json({ error: 'Failed to filter nodes by publication date' });
    } finally {
        await session.close();
    }
});

// Filter nodes by publication date range
app.get('/api/filter/date-range', async (req, res) => {
    const { startDate, endDate } = req.query;
    const session = driver.session();
    try {
        const result = await session.run(
            `MATCH (n)
            WHERE n.publicationDate >= $startDate AND n.publicationDate <= $endDate
            RETURN n, labels(n) as nLabels`
            , { startDate, endDate }
        );

        const nodes = result.records.map(record => {
            return { ...record.get('n').properties, label: record.get('nLabels')[0] };
        });

        res.json(nodes);
    } catch (error) {
        console.error('Error filtering nodes by publication date range:', error);
        res.status(500).json({ error: 'Failed to filter nodes by publication date range' });
    } finally {
        await session.close();
    }
});

// Filter nodes by author/reference
app.get('/api/filter/author-reference/:author', async (req, res) => {
    const { author } = req.params;
    const session = driver.session();
    try {
        const result = await session.run(
            `MATCH (n)-[r:Reference]->(m)
            WHERE toLower(r.author) CONTAINS toLower($author) OR toLower(r.reference) CONTAINS toLower($author)
            RETURN n, labels(n) as nLabels, r, m, labels(m) as mLabels`
            , { author }
        );

        const nodes = new Map();
        result.records.forEach(record => {
            const startNode = record.get('n').properties;
            const startNodeLabel = record.get('nLabels')[0];
            const endNode = record.get('m') ? record.get('m').properties : null;
            const endNodeLabel = record.get('mLabels') ? record.get('mLabels')[0] : null;

            if (!nodes.has(startNode.name)) {
                nodes.set(startNode.name, { ...startNode, label: startNodeLabel });
            }

            if (endNode && !nodes.has(endNode.name)) {
                nodes.set(endNode.name, { ...endNode, label: endNodeLabel });
            }
        });

        const relationships = result.records
            .filter(record => record.get('r'))
            .map(record => ({
                source: record.get('n').properties.name,
                target: record.get('m').properties.name,
                name: record.get('r').properties.name,
                type: record.get('r').properties.type
            }));

        res.json({ nodes: Array.from(nodes.values()), relationships });
    } catch (error) {
        console.error('Error filtering by author/reference:', error);
        res.status(500).json({ error: 'Failed to filter by author/reference' });
    } finally {
        await session.close();
    }
});

// Filter nodes by tag
app.get('/api/filter/tag/:tag', async (req, res) => {
    const { tag } = req.params;
    const session = driver.session();
    try {
        const result = await session.run(
            `MATCH (n)
            WHERE any(tag IN n.tags WHERE toLower(tag) CONTAINS toLower($tag))
            RETURN n, labels(n) as nLabels`
            , { tag }
        );

        const nodes = result.records.map(record => {
            return { ...record.get('n').properties, label: record.get('nLabels')[0] };
        });

        res.json(nodes);
    } catch (error) {
        console.error('Error filtering nodes by tag:', error);
        res.status(500).json({ error: 'Failed to filter nodes by tag' });
    } finally {
        await session.close();
    }
});

// Filter nodes by color
app.get('/api/filter/color/:color', async (req, res) => {
    const { color } = req.params;
    const session = driver.session();
    try {
        const result = await session.run(
            `MATCH (n)
            WHERE toLower(n.color) = '#'+toLower($color)
            RETURN n, labels(n) as nLabels`
            , { color }
        );

        const nodes = result.records.map(record => {
            return { ...record.get('n').properties, label: record.get('nLabels')[0] };
        });

        res.json(nodes);
    } catch (error) {
        console.error('Error filtering nodes by color:', error);
        res.status(500).json({ error: 'Failed to filter nodes by color' });
    } finally {
        await session.close();
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
