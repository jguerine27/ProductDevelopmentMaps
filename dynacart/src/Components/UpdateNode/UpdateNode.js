import React, { useState, useEffect } from 'react';

const UpdateNode = () => {
    const [labels, setLabels] = useState([]);
    const [selectedLabel, setSelectedLabel] = useState('');
    const [nodes, setNodes] = useState([]);
    const [selectedNode, setSelectedNode] = useState('');
    const [nodeDetails, setNodeDetails] = useState({});
    const [originalNodeName, setOriginalNodeName] = useState('');
    const [message, setMessage] = useState('');
    const [showPopup, setShowPopup] = useState(false);

    // Fetch available labels on component mount
    useEffect(() => {
        const fetchLabels = async () => {
            try {
                const response = await fetch('http://localhost:4000/api/node-labels');
                const data = await response.json();
                setLabels(data);
            } catch (error) {
                console.error('Error fetching labels:', error);
            }
        };
        fetchLabels();
    }, []);

    // Handle label change and fetch corresponding nodes
    const handleLabelChange = async (label) => {
        setSelectedLabel(label);
        setSelectedNode('');
        setNodeDetails({});
        setOriginalNodeName('');

        try {
            const response = await fetch(`http://localhost:4000/api/node-names/` + label);
            const data = await response.json();
            setNodes(data);
        } catch (error) {
            console.error('Error fetching nodes:', error);
        }
    };

    // Handle node selection and fetch its details
    const handleNodeChange = async (nodeName) => {
        setSelectedNode(nodeName);

        try {
            const response = await fetch(`http://localhost:4000/api/node-details/${nodeName}`);
            const data = await response.json();
            setNodeDetails(data);
            setOriginalNodeName(nodeName); // Store the original name
        } catch (error) {
            console.error('Error fetching node details:', error);
        }
    };

    // Handle input changes in the node details form
    const handleInputChange = (event) => {
        const { name, value } = event.target;
        setNodeDetails(prevState => ({
            ...prevState,
            [name]: value
        }));
    };

    // Show the confirmation popup
    const handleSubmit = () => {
        setShowPopup(true);
    };

    // Ensure tags and citations are always passed as lists of strings
    const ensureListFormat = (value) => {
        if (typeof value === 'string') {
            const trimmedValue = value.trim();
            if (trimmedValue === '') {
                return []; // Return empty list if input is empty or contains only whitespace
            }
            return trimmedValue.split(',').map(item => item.trim());
        }
        return []; // Return empty list for non-string inputs
    };

    // Handle the confirmation of the update
    const handleConfirmUpdate = async () => {
        try {
            const response = await fetch('http://localhost:4000/api/update-node', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    oldName: originalNodeName, // Pass the old name
                    newName: nodeDetails.name || '', // Pass the new name, default to empty string if not provided
                    tags: ensureListFormat(nodeDetails.tags || ''), // Ensure tags are a list of strings
                    citations: ensureListFormat(nodeDetails.citations || '') // Ensure citations are a list of strings
                })
            });

            if (response.ok) {
                setMessage('Node updated successfully.');
            } else {
                setMessage('Failed to update node.');
            }
        } catch (error) {
            console.error('Error updating node:', error);
            setMessage('Failed to update node.');
        } finally {
            setShowPopup(false); // Close the popup
        }
    };

    // Handle the discard action
    const handleDiscardUpdate = () => {
        setShowPopup(false); // Close the popup
    };

    return (
        <div>
            <h2>Update Node</h2>
            {message && <p>{message}</p>}

            <div>
                <label>Select Label: </label>
                <select value={selectedLabel} onChange={(e) => handleLabelChange(e.target.value)}>
                    <option value="">-- Select Label --</option>
                    {labels.map(label => (
                        <option key={label} value={label}>{label}</option>
                    ))}
                </select>
            </div>

            {selectedLabel && (
                <div>
                    <label>Select Node: </label>
                    <select value={selectedNode} onChange={(e) => handleNodeChange(e.target.value)}>
                        <option value="">-- Select Node --</option>
                        {nodes.map(node => (
                            <option key={node} value={node}>{node}</option>
                        ))}
                    </select>
                </div>
            )}

            {selectedNode && (
                <div>
                    <h3>Update Node Details</h3>
                    {['name', 'tags', 'citations'].map((key) => (
                        <div key={key}>
                            <label>{key.charAt(0).toUpperCase() + key.slice(1)}: </label>
                            <input 
                                type="text" 
                                name={key} 
                                value={nodeDetails[key] || ''} 
                                onChange={handleInputChange} 
                            />
                        </div>
                    ))}

                    <button onClick={handleSubmit}>Submit</button>
                </div>
            )}

            {showPopup && (
                <div className="modal-overlay">
                    <div className="modal">
                        <h3>Are you sure you want to update this node?</h3>
                        <button onClick={handleConfirmUpdate}>Confirm</button>
                        <button onClick={handleDiscardUpdate}>Discard</button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default UpdateNode;
