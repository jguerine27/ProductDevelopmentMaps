const neo4j = require('neo4j-driver');
require('dotenv').config();

const URI = process.env.NEO4J_URI;
const USER = process.env.NEO4J_USER;
const PASSWORD = process.env.NEO4J_PASSWORD;

const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));

// --------------------
// NODES
// --------------------
const nodes = [
  // Approaches
  { label: 'Approach', name: 'Systems engineering', map: 'CPS Development', citations: 'Paetzold 2017' },
  { label: 'Approach', name: 'Agile', map: 'CPS Development', citations: 'Beck et al., 2001' },
  { label: 'Approach', name: 'Extreme programming', map: 'CPS Development', citations: 'Luepke et al., 2018' },

  // Processes
  { label: 'Process', name: 'V-model', map: 'CPS Development', citations: 'Merlo et al., 2019' },
  { label: 'Process', name: 'W-model', map: 'CPS Development', citations: 'Merlo et al., 2019' },
  { label: 'Process', name: 'Scrum CPS', map: 'CPS Development', citations: 'Wagner, 2014' },
  { label: 'Process', name: 'Scrum', map: 'CPS Development', citations: 'Schwaber, 1997' },
  { label: 'Process', name: 'Agile product development', map: 'CPS Development', citations: 'Luepke et al., 2018' },

  // Methods
  { label: 'Method', name: 'Model-based and model-driven practices', map: 'CPS Development', citations: 'Jensen et al., 2018; Hoock et al., 2018; Kagemann et al., 2018; Fu et al., 2018; Reifenscheid, 2017; Rajkumar et al., 2010' },
  { label: 'Method', name: 'Creativity methods', map: 'CPS Development', citations: '' },
  { label: 'Method', name: 'Test-driven development', map: 'CPS Development', citations: 'Fu et al., 2018' },
  { label: 'Method', name: 'Continuous integration', map: 'CPS Development', citations: 'Sepúlveda et al., 2017; Sutijono et al., 2018' },
  { label: 'Method', name: 'Data-driven design', map: 'CPS Development', citations: 'Wagner, 2014; Fitzgerald et al., 2015; Sanghvi et al., 2018; Pease et al., 2017; Kang et al., 2016; Aluri, 2015' },
  { label: 'Method', name: 'SYSMOD', map: 'CPS Development', citations: 'Paetzold 2017' },
  { label: 'Method', name: 'OOSEM', map: 'CPS Development', citations: 'Paetzold 2017' },
  { label: 'Method', name: 'User/Human-centered design', map: 'CPS Development', citations: 'Broy and Schmidt, 2014; Brown et al., 2015; Wróbel et al., 2015' },
  { label: 'Method', name: 'Black box and white box analyses', map: 'CPS Development', citations: '' },
  { label: 'Method', name: 'Design thinking', map: 'CPS Development', citations: 'Luedeke et al., 2018; Huther, 2012' },
  { label: 'Method', name: 'Property-driven development', map: 'CPS Development', citations: 'Baumgartner et al., 2004' },

  // Tools
  { label: 'Tool', name: 'Aspect-oriented modelling techniques', map: 'CPS Development', citations: 'Pease et al., 2017' },
  { label: 'Tool', name: 'Object-oriented modelling', map: 'CPS Development', citations: 'Penas et al., 2017' },
  { label: 'Tool', name: 'System modelling techniques', map: 'CPS Development', citations: 'Penas and Hasselink, 2018; Sörös et al., 2011; Attarha et al., 2018; Otter and Sander, 2016; Liu et al., 2016; Wu, 2016; Kagemann et al., 2013; Rajkumar et al., 2010' },
  { label: 'Tool', name: 'Port-based modelling', map: 'CPS Development', citations: 'Pease et al., 2017' },
  { label: 'Tool', name: 'Model/Hardware/Software-in-the-loop', map: 'CPS Development', citations: '' },
  { label: 'Tool', name: 'Bond graph', map: 'CPS Development', citations: '' },
  { label: 'Tool', name: 'Sprint', map: 'CPS Development', citations: '' },
  { label: 'Tool', name: 'Backlog', map: 'CPS Development', citations: '' },
  { label: 'Tool', name: 'User stories', map: 'CPS Development', citations: '' },
  { label: 'Tool', name: 'Characteristics properties modelling', map: 'CPS Development', citations: '' },
  { label: 'Tool', name: 'Design sprint', map: 'CPS Development', citations: '' },
  { label: 'Tool', name: 'Hardware sprint', map: 'CPS Development', citations: '' },
  { label: 'Tool', name: 'Agent-based modelling', map: 'CPS Development', citations: 'Henneberger et al., 2016; Camara et al., 2017; Hoock et al., 2018; Herff et al., 2019; Penas et al., 2017' }
];

// --------------------
// RELATIONSHIPS
// --------------------
const relationships = [
  // Format: { from, to, author, type }
  // Approaches to Processes
  { from: 'Systems engineering', to: 'V-model', author: 'Paetzold 2017', type: 'ec' },
  { from: 'Systems engineering', to: 'W-model', author: 'Merlo et al., 2019', type: 'ec' },
  { from: 'Agile', to: 'Scrum', author: 'Schwaber, 1997', type: 'ec' },
  { from: 'Agile', to: 'Scrum CPS', author: 'Wagner, 2014', type: 'ec' },
  { from: 'Agile', to: 'Agile product development', author: 'Luepke et al., 2018', type: 'ec' },
  { from: 'Extreme programming', to: 'Agile product development', author: 'Luepke et al., 2018', type: 'ec' },

  // Processes to Methods
  { from: 'V-model', to: 'Model-based and model-driven practices', author: 'Paetzold 2017', type: 'oc' },
  { from: 'W-model', to: 'Model-based and model-driven practices', author: 'Merlo et al., 2019', type: 'oc' },
  { from: 'Scrum CPS', to: 'Model-based and model-driven practices', author: 'Wagner, 2014', type: 'oc' },
  { from: 'Scrum', to: 'Model-based and model-driven practices', author: 'Wagner, 2014', type: 'oc' },
  { from: 'Agile product development', to: 'Model-based and model-driven practices', author: 'Luepke et al., 2018', type: 'oc' },

  // Methods to Methods
  { from: 'Model-based and model-driven practices', to: 'Creativity methods', author: 'Hoock et al., 2018', type: 'oc' },
  { from: 'Model-based and model-driven practices', to: 'Test-driven development', author: 'Fu et al., 2018', type: 'oc' },
  { from: 'Model-based and model-driven practices', to: 'Continuous integration', author: 'Sepúlveda et al., 2017', type: 'oc' },
  { from: 'Model-based and model-driven practices', to: 'Data-driven design', author: 'Wagner, 2014', type: 'oc' },
  { from: 'Model-based and model-driven practices', to: 'SYSMOD', author: 'Paetzold 2017', type: 'oc' },
  { from: 'Model-based and model-driven practices', to: 'OOSEM', author: 'Paetzold 2017', type: 'oc' },
  { from: 'Model-based and model-driven practices', to: 'User/Human-centered design', author: 'Broy and Schmidt, 2014', type: 'oc' },
  { from: 'Model-based and model-driven practices', to: 'Black box and white box analyses', author: 'Wróbel et al., 2015', type: 'oc' },
  { from: 'Model-based and model-driven practices', to: 'Design thinking', author: 'Luedeke et al., 2018', type: 'oc' },
  { from: 'Model-based and model-driven practices', to: 'Property-driven development', author: 'Baumgartner et al., 2004', type: 'oc' },

  // Methods to Tools
  { from: 'Test-driven development', to: 'Aspect-oriented modelling techniques', author: 'Pease et al., 2017', type: 'oc' },
  { from: 'Continuous integration', to: 'Object-oriented modelling', author: 'Penas et al., 2017', type: 'oc' },
  { from: 'Data-driven design', to: 'System modelling techniques', author: 'Penas and Hasselink, 2018', type: 'oc' },
  { from: 'SYSMOD', to: 'Port-based modelling', author: 'Pease et al., 2017', type: 'oc' },
  { from: 'OOSEM', to: 'Model/Hardware/Software-in-the-loop', author: 'Pease et al., 2017', type: 'oc' },
  { from: 'User/Human-centered design', to: 'Bond graph', author: 'Pease et al., 2017', type: 'oc' },
  { from: 'Black box and white box analyses', to: 'Sprint', author: 'Wagner, 2014', type: 'oc' },
  { from: 'Design thinking', to: 'Backlog', author: 'Luedeke et al., 2018', type: 'oc' },
  { from: 'Property-driven development', to: 'User stories', author: 'Baumgartner et al., 2004', type: 'oc' },

  // Tools to Tools
  { from: 'Aspect-oriented modelling techniques', to: 'System modelling techniques', author: 'Pease et al., 2017', type: 'oc' },
  { from: 'Object-oriented modelling', to: 'Port-based modelling', author: 'Pease et al., 2017', type: 'oc' },
  { from: 'System modelling techniques', to: 'Model/Hardware/Software-in-the-loop', author: 'Pease et al., 2017', type: 'oc' },
  { from: 'Port-based modelling', to: 'Agent-based modelling', author: 'Henneberger et al., 2016', type: 'oc' },

  // Tools to Tools (Agile)
  { from: 'Sprint', to: 'Backlog', author: 'Wagner, 2014', type: 'oc' },
  { from: 'Backlog', to: 'User stories', author: 'Luedeke et al., 2018', type: 'oc' },
  { from: 'User stories', to: 'Characteristics properties modelling', author: 'Luedeke et al., 2018', type: 'oc' },
  { from: 'Characteristics properties modelling', to: 'Design sprint', author: 'Luedeke et al., 2018', type: 'oc' },
  { from: 'Design sprint', to: 'Hardware sprint', author: 'Luedeke et al., 2018', type: 'oc' },
  { from: 'Hardware sprint', to: 'Agent-based modelling', author: 'Henneberger et al., 2016', type: 'oc' },

  // Example of h (dotted with arrowhead)
  { from: 'Model-based and model-driven practices', to: 'SYSMOD', author: 'Paetzold 2017', type: 'h' },
  { from: 'Model-based and model-driven practices', to: 'OOSEM', author: 'Paetzold 2017', type: 'h' },
  { from: 'Model-based and model-driven practices', to: 'User/Human-centered design', author: 'Broy and Schmidt, 2014', type: 'h' },
  { from: 'Model-based and model-driven practices', to: 'Black box and white box analyses', author: 'Wróbel et al., 2015', type: 'h' },
  { from: 'Model-based and model-driven practices', to: 'Design thinking', author: 'Luedeke et al., 2018', type: 'h' },
  { from: 'Model-based and model-driven practices', to: 'Property-driven development', author: 'Baumgartner et al., 2004', type: 'h' }
];

// --------------------
// SCRIPT
// --------------------
async function populateCPSDevelopment() {
  const session = driver.session();
  try {
    // Add nodes
    for (const node of nodes) {
      const cypher = `
        MERGE (n:${node.label} {name: $name})
        SET n.map = $map,
            n.citations = $citations
      `;
      await session.run(cypher, node);
      console.log(`Node merged: ${node.label} - ${node.name}`);
    }

    // Add relationships
    for (const rel of relationships) {
      const cypher = `
        MATCH (a {name: $from}), (b {name: $to})
        MERGE (a)-[r:RELATED {author: $author, type: $type}]->(b)
      `;
      await session.run(cypher, rel);
      console.log(`Relationship created: ${rel.from} -> ${rel.to} [${rel.type}]`);
    }

    console.log('CPS Development map populated successfully!');
  } catch (error) {
    console.error('Error populating CPS Development map:', error);
  } finally {
    await session.close();
    await driver.close();
  }
}

populateCPSDevelopment();