const express = require('express');
const neo4j = require('neo4j-driver');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');
const bodyParser = require('body-parser');


// Replace with the path to your service account key file
const serviceAccount = require('./dynacart-ba40e-firebase-adminsdk-kutg0-4344c5ba7f.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://console.firebase.google.com/u/0/project/dynacart-ba40e/database/dynacart-ba40e-default-rtdb/data/~2F'
});

const app = express();
app.use(bodyParser.json());

const ORCID_CLIENT_ID = process.env.ORCID_CLIENT_ID;
const ORCID_CLIENT_SECRET = process.env.ORCID_CLIENT_SECRET;
const ORCID_REDIRECT_URI = process.env.ORCID_REDIRECT_URI; // Change to your actual redirect URI

app.get('/orcid/login', (req, res) => {
  const authorizationUrl = `https://orcid.org/oauth/authorize?client_id=${ORCID_CLIENT_ID}&response_type=code&scope=/authenticate&redirect_uri=${ORCID_REDIRECT_URI}`;
  res.redirect(authorizationUrl);
});
app.get('/orcid/callback', async (req, res) => {
    const { code } = req.query;
  
    try {
      const tokenResponse = await axios.post('https://orcid.org/oauth/token', {
        client_id: ORCID_CLIENT_ID,
        client_secret: ORCID_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: ORCID_REDIRECT_URI
      });
  
      const { access_token } = tokenResponse.data;
  
      // Retrieve ORCID iD and other user information
      const userResponse = await axios.get('https://orcid.org/v2.1/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` }
      });
  
      const orcidId = userResponse.data.sub;
  
      // Check if the user exists in Firebase
      let userRecord;
      try {
        userRecord = await admin.auth().getUser(orcidId);
      } catch (error) {
        // User does not exist, create a new user
        userRecord = await admin.auth().createUser({
          uid: orcidId,
          displayName: userResponse.data.name || 'ORCID User',
          email: userResponse.data.email || null,
        });
      }
  
      // Create a custom token for Firebase authentication
      const firebaseToken = await admin.auth().createCustomToken(orcidId);
  
      // Redirect back to your frontend with the custom token
      res.redirect(`http://localhost:3000/orcid/callback?firebaseToken=${firebaseToken}`);
    } catch (error) {
      console.error('Error during ORCID authentication:', error);
      res.status(500).send('Authentication failed');
    }
  });

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

// Fetch all years
app.get('/api/get-years', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(
            'MATCH ()-[r:Reference]->() RETURN DISTINCT r.year AS year'
        );
        const years = result.records.map(record => record.get('year'));
        res.json(years);
    } catch (error) {
        console.error('Error fetching years:', error);
        res.status(500).json({ error: 'Failed to fetch years' });
    } finally {
        await session.close();
    }
});

// Fetch all authors/references
app.get('/api/get-authors', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(
            'MATCH ()-[r:Reference]->() RETURN DISTINCT r.author AS author, r.name AS name'
        );
        const authors = result.records.map(record => record.get('author'));
        res.json(authors);
    } catch (error) {
        console.error('Error fetching authors:', error);
        res.status(500).json({ error: 'Failed to fetch authors' });
    } finally {
        await session.close();
    }
});
// Fetch all tags
app.get('/api/get-tags', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(
            'MATCH (n) WHERE n.tags IS NOT NULL RETURN n.tags AS tags'
        );
        
        // Flatten the array of tags and remove duplicates
        const tags = result.records
            .map(record => record.get('tags'))
            .flat();
        
        const uniqueTags = Array.from(new Set(tags));
        
        res.json(uniqueTags);
    } catch (error) {
        console.error('Error fetching tags:', error);
        res.status(500).json({ error: 'Failed to fetch tags' });
    } finally {
        await session.close();
    }
});


// Fetch all colors
app.get('/api/get-colors', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(
            'MATCH (n) WHERE n.color IS NOT NULL RETURN DISTINCT n.color AS color'
        );
        const colors = result.records.map(record => record.get('color'));
        res.json(colors);
    } catch (error) {
        console.error('Error fetching colors:', error);
        res.status(500).json({ error: 'Failed to fetch colors' });
    } finally {
        await session.close();
    }
});

app.get('/api/get-approaches', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(
            'MATCH (n) WHERE n.approach IS NOT NULL RETURN DISTINCT n.approach AS approach'
        );
        const approaches = result.records.map(record => record.get('approach'));
        res.json(approaches);
    } catch (error) {
        console.error('Error fetching types:', error);
        res.status(500).json({ error: 'Failed to fetch approaches' });
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
});// Filter nodes by keyword
// Filter nodes and relationships by keyword, checking only string properties
app.get('/api/filter/keyword/:keyword', async (req, res) => {
    const { keyword } = req.params;
    const session = driver.session();
    try {
        const query = `
            MATCH (n)-[r]->(m)
             WHERE 
                toLower(n.name) CONTAINS toLower($keyword) 
                OR any(label IN labels(n) WHERE toLower(label) CONTAINS toLower($keyword))
                OR any(label IN labels(m) WHERE toLower(label) CONTAINS toLower($keyword))
             OPTIONAL MATCH (m)
             WHERE 
                any(label IN labels(m) WHERE toLower(label) CONTAINS toLower($keyword))
             RETURN DISTINCT n, labels(n) AS nLabels, r, m, labels(m) AS mLabels
             UNION
             MATCH (n)
             WHERE
                toLower(n.name) CONTAINS toLower($keyword)
                OR any(label IN labels(n) WHERE toLower(label) CONTAINS toLower($keyword))
             OPTIONAL MATCH (n)-[r]->(m)
             WHERE
                m IS NULL OR any(label IN labels(m) WHERE toLower(label) CONTAINS toLower($keyword))
             RETURN DISTINCT n, labels(n) AS nLabels, r, m, labels(m) AS mLabels
        `;

        const nodesResult = await session.run(query, { keyword });

        const nodes = new Map();
        nodesResult.records.forEach(record => {
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

        const relationships = nodesResult.records
            .filter(record => record.get('r'))
            .map(record => ({
                source: record.get('n').properties.name,
                target: record.get('m').properties.name,
                name: record.get('r').properties.name,
                type: record.get('r').properties.type,
                year: record.get('r').properties.year
            }));

        res.json({ nodes: Array.from(nodes.values()), relationships });
    } catch (error) {
        console.error('Error filtering by keyword:', error);
        res.status(500).json({ error: 'Failed to filter by keyword' });
    } finally {
        await session.close();
    }
});


// Filter nodes and relationships by year (stored as STRING in Neo4j)
// Filter nodes by multiple years
app.get('/api/filter/year/:year', async (req, res) => {
    const { year } = req.params;
  
    if (!year) {
      return res.status(400).json({ error: 'Year parameter is required' });
    }
  
    // Parse year parameter into an array of years
    const yearArray = year.split(',').map(y => y.trim());
  
    const session = driver.session();
  
    try {
      // Filter nodes by multiple years
      const nodesResult = await session.run(
        `MATCH (n)-[r:Reference]->(m)
         WHERE r.year IN $yearArray
         RETURN DISTINCT n, m, r`,
        { yearArray }
      );
  
      const nodes = new Map();
      nodesResult.records.forEach(record => {
        const startNode = record.get('n').properties;
        const startNodeLabel = record.get('n').labels[0];
        const endNode = record.get('m') ? record.get('m').properties : null;
        const endNodeLabel = record.get('m') ? record.get('m').labels[0] : null;
        const relationship = record.get('r').properties;
  
        if (!nodes.has(startNode.name)) {
          nodes.set(startNode.name, { ...startNode, label: startNodeLabel });
        }
  
        if (endNode && !nodes.has(endNode.name)) {
          nodes.set(endNode.name, { ...endNode, label: endNodeLabel });
        }
      });
  
      const relationships = nodesResult.records
        .filter(record => record.get('r'))
        .map(record => ({
          source: record.get('n').properties.name,
          target: record.get('m').properties.name,
          name: record.get('r').properties.name,
          type: record.get('r').properties.type,
          year: record.get('r').properties.year
        }));
  
      res.json({ nodes: Array.from(nodes.values()), relationships });
    } catch (error) {
      console.error('Error filtering nodes and relationships by year:', error);
      res.status(500).json({ error: 'Failed to filter nodes and relationships by year' });
    } finally {
      await session.close();
    }
  });
  

// Filter nodes and relationships by year range (years stored as STRING in Neo4j)
app.get('/api/filter/yearrange', async (req, res) => {
  const { startYear, endYear } = req.query;

  if (!startYear || !endYear) {
    return res.status(400).json({ error: 'Both startYear and endYear parameters are required' });
  }

  const session = driver.session();

  try {
    // Filter nodes by year range
    const nodesResult = await session.run(
      `MATCH (n)-[r:Reference]->(m)
       WHERE r.year >= $startYear AND r.year <= $endYear
       RETURN DISTINCT n, m, r`,
      { startYear, endYear }
    );

    const nodes = new Map();
    nodesResult.records.forEach(record => {
      const startNode = record.get('n').properties;
      const startNodeLabel = record.get('n').labels[0];
      const endNode = record.get('m') ? record.get('m').properties : null;
      const endNodeLabel = record.get('m') ? record.get('m').labels[0] : null;
      const relationship = record.get('r').properties;

      if (!nodes.has(startNode.name)) {
        nodes.set(startNode.name, { ...startNode, label: startNodeLabel });
      }

      if (endNode && !nodes.has(endNode.name)) {
        nodes.set(endNode.name, { ...endNode, label: endNodeLabel });
      }
    });

    const relationships = nodesResult.records
      .filter(record => record.get('r'))
      .map(record => ({
        source: record.get('n').properties.name,
        target: record.get('m').properties.name,
        name: record.get('r').properties.name,
        type: record.get('r').properties.type,
        year: record.get('r').properties.year
      }));

    res.json({ nodes: Array.from(nodes.values()), relationships });
  } catch (error) {
    console.error('Error filtering nodes and relationships by year range:', error);
    res.status(500).json({ error: 'Failed to filter nodes and relationships by year range' });
  } finally {
    await session.close();
  }
});

// Filter nodes by multiple authors/references
app.get('/api/filter/author-reference/:author', async (req, res) => {
    const { author } = req.params;

    if (!author) {
        return res.status(400).json({ error: 'Author parameter is required' });
    }

    // Parse author parameter into an array of authors
    const authorArray = author.split(',').map(a => a.trim().toLowerCase());

    const session = driver.session();

    try {
        const result = await session.run(
            `MATCH (n)-[r:Reference]->(m)
             WHERE ANY(a IN $authorArray WHERE toLower(r.author) CONTAINS a OR toLower(r.reference) CONTAINS a)
             RETURN DISTINCT n, labels(n) AS nLabels, r, m, labels(m) AS mLabels`,
            { authorArray }
        );

        const nodes = new Map();
        result.records.forEach(record => {
            const startNode = record.get('n').properties;
            const startNodeLabel = record.get('nLabels')[0];
            const endNode = record.get('m') ? record.get('m').properties : null;
            const endNodeLabel = record.get('m') ? record.get('m').labels[0] : null;
            const relationship = record.get('r').properties;

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
app.get('/api/filter/tag/:tags', async (req, res) => {
    const { tags } = req.params;

    let tagArray;
    tagArray = tags.split(',');

    const session = driver.session();

    try {
        const result = await session.run(
            `MATCH (n)
             WHERE ANY(tag IN n.tags WHERE ANY(t IN $tagArray WHERE toLower(tag) CONTAINS toLower(t)))
             OPTIONAL MATCH (n)-[r]->(m)
             WHERE (m IS NULL OR ANY(tag IN m.tags WHERE ANY(t IN $tagArray WHERE toLower(tag) CONTAINS toLower(t))))
             RETURN n, labels(n) AS nLabels, m, labels(m) AS mLabels, r`,
            { tagArray }
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
        console.error('Error filtering by tag:', error);
        res.status(500).json({ error: 'Failed to filter by tag' });
    } finally {
        await session.close();
    }
});



// Filter nodes by color
app.get('/api/filter/color/:color', async (req, res) => {
    let { color } = req.params;
    console.log(color);
    color = color.split(',');

    const session = driver.session();

    try {
        const result = await session.run(
            `MATCH (n)
             WHERE ANY(c IN $color WHERE toLower(n.color) = '#' + toLower(c))
             OPTIONAL MATCH (n)-[r]->(m)
             WHERE ANY(c IN $color WHERE toLower(n.color) = '#' + toLower(c))
             AND (m IS NULL OR ANY(c IN $color WHERE toLower(m.color) = '#' + toLower(c)))
             RETURN n, labels(n) AS nLabels, m, labels(m) AS mLabels, r`,
            { color }
        );

        console.log(result);

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
        console.error('Error filtering by color:', error);
        res.status(500).json({ error: 'Failed to filter by color' });
    } finally {
        await session.close();
    }
});
// Apply all filters API
app.get('/api/filter/all', async (req, res) => {
    const { keyword, year, startYear, endYear, author, tags, color } = req.query;

    console.log('keyword', keyword);
    console.log('year', year);
    console.log('startYear', startYear);
    console.log('endYear', endYear);
    console.log('author', author);
    console.log('tags', tags);
    console.log('color', color);

    const session = driver.session();
    
    try {
        const queryParts = [];
        const params = {};

        // Keyword filter
        if (keyword && keyword.length > 0) {
            queryParts.push(`
                (
                    toLower(n.name) CONTAINS toLower($keyword) 
                    OR any(label IN labels(n) WHERE toLower(label) CONTAINS toLower($keyword))
                    OR any(label IN labels(m) WHERE toLower(label) CONTAINS toLower($keyword))
                )
            `);
            params.keyword = keyword;
        }

        // Year filter
        if (year && year.length > 0) {
            const yearArray = Array.isArray(year) ? year : year.split(',').map(y => y.trim());
            queryParts.push(`r.year IN $yearArray`);
            params.yearArray = yearArray;
        }

        // Year range filter
        if (startYear && startYear.length > 0 && endYear && endYear.length > 0) {
            queryParts.push(`r.year >= $startYear AND r.year <= $endYear`);
            params.startYear = startYear;
            params.endYear = endYear;
        }

        // Author/reference filter
        if (author && author.length > 0) {
            const authorArray = Array.isArray(author) ? author : author.split(',').map(a => a.trim().toLowerCase());
            queryParts.push(`ANY(a IN $authorArray WHERE toLower(r.author) CONTAINS a OR toLower(r.reference) CONTAINS a)`);
            params.authorArray = authorArray;
        }

        // Tag filter
        if (tags && tags.length > 0) {
            const tagArray = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim().toLowerCase());
            queryParts.push(`ANY(tag IN n.tags WHERE ANY(t IN $tagArray WHERE toLower(tag) CONTAINS toLower(t)))`);
            params.tagArray = tagArray;
        }

        // Color filter
        if (color && color.length > 0) {
            const colorArray = Array.isArray(color) ? color : color.split(',').map(c => c.trim().toLowerCase());
            queryParts.push(`ANY(c IN $colorArray WHERE toLower(n.color) = toLower(c))`);
            params.colorArray = colorArray;
        }

        // Combine all query parts
        const query = `
            MATCH (n)-[r]->(m)
            ${queryParts.length > 0 ? `WHERE ${queryParts.join(' AND ')}` : ''}
            OPTIONAL MATCH (m)
            RETURN DISTINCT n, labels(n) AS nLabels, r, m, labels(m) AS mLabels
        `;
        console.log(query);
        const result = await session.run(query, params);

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
                type: record.get('r').properties.type,
                year: record.get('r').properties.year
            }));

        res.json({ nodes: Array.from(nodes.values()), relationships });
    } catch (error) {
        console.error('Error applying filters:', error);
        res.status(500).json({ error: 'Failed to apply filters' });
    } finally {
        await session.close();
    }
});




app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

module.exports = app;
