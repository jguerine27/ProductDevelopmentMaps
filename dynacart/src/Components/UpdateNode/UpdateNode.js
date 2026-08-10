import React, { useState, useEffect } from 'react';
import apiClient from '../../api/client';

const UpdateNode = () => {
    const [labels, setLabels] = useState([]);
    const [selectedLabel, setSelectedLabel] = useState('');
    const [nodes, setNodes] = useState([]);
    const [selectedNode, setSelectedNode] = useState('');
    const [nodeDetails, setNodeDetails] = useState({});
    const [originalNodeName, setOriginalNodeName] = useState('');
    const [originalTags, setOriginalTags] = useState([]);
    const [originalCitations, setOriginalCitations] = useState([]);
    const [message, setMessage] = useState('');
    const [showPopup, setShowPopup] = useState(false);

    // Fetch available labels on component mount
    useEffect(() => {
        const fetchLabels = async () => {
            try {
                const response = await apiClient.get('/api/node-labels');
                const data = response.data;
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
        setOriginalTags([]);
        setOriginalCitations([]);

        try {
            const response = await apiClient.get(`/api/node-names/${label}`);
            const data = response.data;
            setNodes(data);
        } catch (error) {
            console.error('Error fetching nodes:', error);
        }
    };

    // Handle node selection and fetch its details
    const handleNodeChange = async (nodeName) => {
        setSelectedNode(nodeName);

        try {
            const response = await apiClient.get(`/api/node-details/${nodeName}`);
            const data = response.data;
            setNodeDetails(data);
            setOriginalNodeName(nodeName); // Store the original name
            setOriginalTags(data.tags || []); // Store original tags
            setOriginalCitations(data.citations || []); // Store original citations
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
    const ensureListFormat = (value, originalValue) => {
        if (typeof value === 'string') {
            const trimmedValue = value.trim();
            if (trimmedValue === '') {
                return originalValue; // Use original value if input is empty
            }
            return trimmedValue.split(',').map(item => item.trim());
        }
        return originalValue; // Use original value for non-string inputs
    };

    // Handle the confirmation of the update
    const handleConfirmUpdate = async () => {
        try {
            const response = await apiClient.post('/api/update-node', {
                oldName: originalNodeName, // Pass the old name
                newName: nodeDetails.name || '', // Pass the new name, default to empty string if not provided
                tags: ensureListFormat(nodeDetails.tags, originalTags), // Ensure tags are a list of strings
                citations: ensureListFormat(nodeDetails.citations, originalCitations) // Ensure citations are a list of strings
            });

            if (response.status === 200) {
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
