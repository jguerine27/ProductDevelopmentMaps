import React, { useState, useEffect } from 'react';

const AddReferenceForm = () => {
    const [nodeLabels, setNodeLabels] = useState([]);
    const [selectedLabel1, setSelectedLabel1] = useState('');
    const [nodeNames1, setNodeNames1] = useState([]);
    const [selectedNodeName1, setSelectedNodeName1] = useState('');
    const [selectedLabel2, setSelectedLabel2] = useState('');
    const [nodeNames2, setNodeNames2] = useState([]);
    const [selectedNodeName2, setSelectedNodeName2] = useState('');
    const [referenceName, setReferenceName] = useState('');
    const [year, setYear] = useState('');
    const [author, setAuthor] = useState('');
    const [type, setType] = useState('');
    const [message, setMessage] = useState('');

    useEffect(() => {
        const fetchLabels = async () => {
            try {
                const response = await fetch('http://localhost:4000/api/node-labels');
                if (response.ok) {
                    const labels = await response.json();
                    setNodeLabels(labels);
                } else {
                    throw new Error('Failed to fetch node labels');
                }
            } catch (error) {
                console.error('Error fetching node labels:', error);
            }
        };

        fetchLabels();
    }, []);

    const fetchNodeNames = async (label, setter) => {
        try {
            const response = await fetch(`http://localhost:4000/api/node-names/${label}`);
            if (response.ok) {
                const names = await response.json();
                setter(names);
            } else {
                throw new Error('Failed to fetch node names');
            }
        } catch (error) {
            console.error(`Error fetching node names for label ${label}:`, error);
        }
    };

    useEffect(() => {
        if (selectedLabel1) {
            fetchNodeNames(selectedLabel1, setNodeNames1);
        }
    }, [selectedLabel1]);

    useEffect(() => {
        if (selectedLabel2) {
            fetchNodeNames(selectedLabel2, setNodeNames2);
        }
    }, [selectedLabel2]);

    useEffect(() => {
        // Exclude selectedNodeName1 from nodeNames2
        setNodeNames2(prevNames => prevNames.filter(name => name !== selectedNodeName1));
    }, [selectedNodeName1]);

    const handleNodeLabel1Change = (label) => {
        setSelectedLabel1(label);
        setSelectedNodeName1('');
    };

    const handleNodeLabel2Change = (label) => {
        setSelectedLabel2(label);
        setSelectedNodeName2('');
    };

    useEffect(() => {
        if (author && year) {
            setReferenceName(`${author} ${year}`);
        } else {
            setReferenceName('');
        }
    }, [author, year]);

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!selectedLabel1 || !selectedNodeName1 || !selectedLabel2 || !selectedNodeName2 || !referenceName || !year || !author || !type) {
            setMessage('Submit all fields');
            return;
        }
        if (selectedLabel1 === selectedLabel2 && selectedNodeName1 === selectedNodeName2) {
            setMessage('Cannot select the same node for both labels');
            return;
        }

        try {
            const response = await fetch('http://localhost:4000/api/submit-reference-for-review', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    nodeLabel1: selectedLabel1,
                    nodeName1: selectedNodeName1,
                    nodeLabel2: selectedLabel2,
                    nodeName2: selectedNodeName2,
                    referenceName: referenceName,
                    year: year,
                    author: author,
                    type
                }),
            });

            const data = await response.json();
            setMessage(data.message || 'Reference submitted for review.');
        } catch (error) {
            console.error('Error submitting reference for review:', error);
            setMessage('An error occurred');
        }
    };

    return (
        <div>
            <h2>Add a Reference/Relation</h2>
            <form onSubmit={handleSubmit}>
                <div>
                    <label>Select Node Label 1:</label>
                    <select value={selectedLabel1} onChange={(e) => handleNodeLabel1Change(e.target.value)}>
                        <option value="">Select a label</option>
                        {nodeLabels.map(label => (
                            <option key={label} value={label}>{label}</option>
                        ))}
                    </select>
                    <label>Node Name 1 (Source):</label>
                    <select
                        value={selectedNodeName1}
                        onChange={(e) => setSelectedNodeName1(e.target.value)}
                    >
                        <option value="">Select a node name</option>
                        {nodeNames1.map(name => (
                            <option key={name} value={name}>{name}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label>Select Node Label 2:</label>
                    <select value={selectedLabel2} onChange={(e) => handleNodeLabel2Change(e.target.value)}>
                        <option value="">Select a label</option>
                        {nodeLabels.map(label => (
                            <option key={label} value={label}>{label}</option>
                        ))}
                    </select>
                    <label>Node Name 2 (Target):</label>
                    <select
                        value={selectedNodeName2}
                        onChange={(e) => setSelectedNodeName2(e.target.value)}
                    >
                        <option value="">Select a node name</option>
                        {nodeNames2.map(name => (
                            <option key={name} value={name}>{name}</option>
                        ))}
                    </select>
                </div>
                
                <div>
                    <label>Reference Author:</label>
                    <input
                        type="text"
                        value={author}
                        onChange={(e) => setAuthor(e.target.value)}
                    />
                </div>

                <div>
                    <label>Reference Year:</label>
                    <input
                        type="text"
                        value={year}
                        onChange={(e) => setYear(e.target.value)}
                    />
                </div>
                
                <div>
                    <label>Reference Name:</label>
                    <input
                        type="text"
                        value={referenceName}
                        readOnly
                        placeholder = "Author Year"
                        style = {{backgroundColor: "lightgrey"}}
                    />
                </div>
                <div>
                    <label>Reference Type:</label>
                    <select value={type} onChange={(e) => setType(e.target.value)}>
                        <option value="">Select a type</option>
                        <option value="ec">Link expressly cited between concepts or techniques (ec)</option>
                        <option value="oc">Link created according to our understanding for overall comprehension (oc)</option>
                        <option value="h">Link pointing towards a hybridization or derivative of a concept or technique (h)</option>
                    </select>
                </div>
                <button type="submit">Submit for Review</button>
            </form>
            {message && <p>{message}</p>}
        </div>
    );
};

export default AddReferenceForm;
