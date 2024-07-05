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

// Fetch all nodes and relationships, including isolated nodes
app.get('/api/nodes-relationships', async (req, res) => {
  const session = driver.session();
  try {
      const result = await session.run(
          `MATCH (n)
           OPTIONAL MATCH (n)-[r]->(m)
           RETURN n, r, m`
      );
      const nodes = new Map();
      result.records.forEach(record => {
          const startNode = record.get('n').properties;
          const endNode = record.get('m') ? record.get('m').properties : null;
          const relationship = record.get('r') ? record.get('r').properties : null;

          if (!nodes.has(startNode.name)) {
              nodes.set(startNode.name, { ...startNode, label: startNode.label });
          }

          if (endNode && !nodes.has(endNode.name)) {
              nodes.set(endNode.name, { ...endNode, label: endNode.label });
          }
      });

      const relationships = result.records
          .filter(record => record.get('r'))
          .map(record => ({
              source: record.get('n').properties.name,
              target: record.get('m').properties.name,
              name: record.get('r').properties.name
          }));

      res.json({ nodes: Array.from(nodes.values()), relationships });
  } catch (error) {
      console.error('Error fetching nodes and relationships:', error);
      res.status(500).json({ error: 'Failed to fetch nodes and relationships' });
  } finally {
      await session.close();
  }
});



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

// Fetch all node labels
app.get('/api/node-labels', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(
            'CALL db.labels()'
        );
        const labels = result.records.map(record => record.get(0));
        res.json(labels);
    } catch (error) {
        console.error('Error fetching node labels:', error);
        res.status(500).json({ error: 'Failed to fetch node labels' });
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
    const { label, name } = req.body;

    const session = driver.session();

    try {
        const result = await session.run(
            `CREATE (n:${label} {name: $name}) RETURN n`,
            { name }
        );

        if (result.records.length > 0) {
            res.status(200).json({ message: 'Node created successfully' });
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

app.post('/create-relationship', async (req, res) => {
  const { nodeLabel1, nodeName1, nodeLabel2, nodeName2, relationshipLabel, relationshipName } = req.body;

  const session = driver.session();

  try {
    const result = await session.run(
      `
      MATCH (a:${nodeLabel1} {name: $nodeName1}), (b:${nodeLabel2} {name: $nodeName2})
      CREATE (a)-[r:${relationshipLabel} {name: $relationshipName}]->(b)
      RETURN r
      `,
      {
        nodeName1,
        nodeName2,
        relationshipName
      }
    );

    if (result.records.length > 0) {
      res.status(200).json({ message: 'Relationship created successfully' });
    } else {
      res.status(404).json({ message: 'One or both nodes not found' });
    }
  } catch (error) {
    console.error('Error creating relationship:', error);
    res.status(500).json({ message: 'An error occurred' });
  } finally {
    await session.close();
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
