import React from 'react';
import './App.css';
import RelationshipForm from './RelationshipForm';

function App() {
    return (
        <div className="App">
            <header className="App-header">
                <h1>Neo4j Relationship Creator</h1>
                <RelationshipForm />
            </header>
        </div>
    );
}

export default App;
