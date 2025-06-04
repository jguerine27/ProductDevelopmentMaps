const neo4j = require('neo4j-driver');
require('dotenv').config();

const URI = process.env.NEO4J_URI;
const USER = process.env.NEO4J_USER;
const PASSWORD = process.env.NEO4J_PASSWORD;

const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));

const data = [
  { label: 'Method', name: 'Hierarchical modelling', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Method', name: 'APTE', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Method', name: 'Black box & white box', type: 'ec', approach: 'The Systems Engineering', color: '#08b4f4', map: 'mechatronic product development', citations: '' },
  { label: 'Method', name: 'Model-centered collaboration', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Method', name: 'Virtual commissioning', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Tool', name: 'Octopus diagram', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Tool', name: 'Horned beast', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Tool', name: 'Petri net', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Tool', name: "Hubka-Eder's model", type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Tool', name: 'FAST diagram', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Tool', name: 'Data-driven empirical', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Tool', name: 'Discrete event system', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Tool', name: 'Multipole modelling', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Tool', name: 'Block diagram', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
  { label: 'Tool', name: 'FMEA', type: 'ec', approach: 'agnostic from approaches', color: '#082464', map: 'mechatronic product development', citations: '' },
];

async function populateDatabase() {
  const session = driver.session();
  try {
    for (const item of data) {
      const cypher = `
        MERGE (n:${item.label} {name: $name})
        SET n.type = $type,
            n.approach = $approach,
            n.color = $color,
            n.map = $map,
            n.citations = $citations
      `;
      await session.run(cypher, item);
      console.log(`Inserted/updated: ${item.label} - ${item.name}`);
    }
    console.log('Database population completed successfully!');
  } catch (error) {
    console.error('Error populating database:', error);
  } finally {
    await session.close();
    await driver.close();
  }
}

populateDatabase(); 