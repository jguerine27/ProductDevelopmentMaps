import React, { useState } from 'react';

const RelationshipForm = () => {
    const [nodeLabel1, setNodeLabel1] = useState('');
    const [nodeName1, setNodeName1] = useState('');
    const [nodeLabel2, setNodeLabel2] = useState('');
    const [nodeName2, setNodeName2] = useState('');
    const [relationshipLabel, setRelationshipLabel] = useState('');
    const [relationshipName, setRelationshipName] = useState('');
    const [message, setMessage] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();

        try {
            const response = await fetch('http://localhost:4000/create-relationship', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    nodeLabel1,
                    nodeName1,
                    nodeLabel2,
                    nodeName2,
                    relationshipLabel,
                    relationshipName,
                }),
            });

            const data = await response.json();

            if (response.ok) {
                setMessage(data.message);
                console.log(data.message);
            } else {
                setMessage(data.message || 'An error occurred');
                console.error(data.message || 'An error occurred');
            }
        } catch (error) {
            console.error('Error creating relationship:', error);
            setMessage('An error occurred');
        }
    };

    return (
        <div>
            <h2>Create Relationship</h2>
            <form onSubmit={handleSubmit}>
                <div>
                    <label>Node Label 1:</label>
                    <input
                        type="text"
                        value={nodeLabel1}
                        onChange={(e) => setNodeLabel1(e.target.value)}
                    />
                </div>
                <div>
                    <label>Node Name 1:</label>
                    <input
                        type="text"
                        value={nodeName1}
                        onChange={(e) => setNodeName1(e.target.value)}
                    />
                </div>
                <div>
                    <label>Node Label 2:</label>
                    <input
                        type="text"
                        value={nodeLabel2}
                        onChange={(e) => setNodeLabel2(e.target.value)}
                    />
                </div>
                <div>
                    <label>Node Name 2:</label>
                    <input
                        type="text"
                        value={nodeName2}
                        onChange={(e) => setNodeName2(e.target.value)}
                    />
                </div>
                <div>
                    <label>Relationship Label:</label>
                    <input
                        type="text"
                        value={relationshipLabel}
                        onChange={(e) => setRelationshipLabel(e.target.value)}
                    />
                </div>
                <div>
                    <label>Relationship Name:</label>
                    <input
                        type="text"
                        value={relationshipName}
                        onChange={(e) => setRelationshipName(e.target.value)}
                    />
                </div>
                <button type="submit">Create Relationship</button>
            </form>
            {message && <p>{message}</p>}
        </div>
    );
};

export default RelationshipForm;
