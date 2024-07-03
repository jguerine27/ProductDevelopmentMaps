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
