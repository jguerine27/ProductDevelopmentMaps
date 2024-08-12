import React, { useState, useEffect } from 'react';
import { ChromePicker } from 'react-color'; // Import the ChromePicker from react-color
import './AddNodeForm.css';

const AddNodeForm = () => {
    const [nodeLabels, setNodeLabels] = useState([]);
    const [selectedLabel, setSelectedLabel] = useState('');
    const [nodeName, setNodeName] = useState('');
    const [color, setColor] = useState('#000000'); // Initialize with a default color
    const [type, setType] = useState('');
    const [citations, setCitations] = useState([]);
    const [citationInput, setCitationInput] = useState('');
    const [tags, setTags] = useState([]);
    const [tagInput, setTagInput] = useState('');
    const [mapOptions, setMapOptions] = useState([]);
    const [selectedMap, setSelectedMap] = useState('');
    const [message, setMessage] = useState('');

    useEffect(() => {
        const fetchLabelsAndMaps = async () => {
            try {
                const [labelsResponse, mapsResponse] = await Promise.all([
                    fetch('http://localhost:4000/api/node-labels'),
                    fetch('http://localhost:4000/api/node-maps')
                ]);

                if (labelsResponse.ok && mapsResponse.ok) {
                    const labels = await labelsResponse.json();
                    const maps = await mapsResponse.json();
                    setNodeLabels(labels);
                    setMapOptions(maps);
                } else {
                    throw new Error('Failed to fetch data');
                }
            } catch (error) {
                console.error('Error fetching data:', error);
            }
        };

        fetchLabelsAndMaps();
    }, []);

    const handleAddCitation = () => {
        if (citationInput) {
            setCitations([...citations, citationInput]);
            setCitationInput('');
        }
    };

    const handleRemoveCitation = (index) => {
        setCitations(citations.filter((_, i) => i !== index));
    };

    const handleAddTag = () => {
        if (tagInput) {
            setTags([...tags, tagInput]);
            setTagInput('');
        }
    };

    const handleRemoveTag = (index) => {
        setTags(tags.filter((_, i) => i !== index));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        // Validation
        if (!selectedLabel || !nodeName || !color || !type || !selectedMap) {
            setMessage('Please fill in all required fields.');
            return;
        }

        try {
            const response = await fetch('http://localhost:4000/api/create-node', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    label: selectedLabel,
                    name: nodeName,
                    type,
                    citations,
                    tags,
                    map: selectedMap,
                    color
                }),
            });

            const data = await response.json();
            setMessage(data.message || 'Node created successfully');
        } catch (error) {
            console.error('Error creating node:', error);
            setMessage('An error occurred');
        }
    };

    return (
        <div>
            <h2>Add a Node</h2>
            <form onSubmit={handleSubmit}>
                <div>
                    <label>Select Node Label:</label>
                    <select value={selectedLabel} onChange={(e) => setSelectedLabel(e.target.value)}>
                        <option value="">Select a label</option>
                        {nodeLabels.map(label => (
                            <option key={label} value={label}>{label}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label>Node Name:</label>
                    <input
                        type="text"
                        value={nodeName}
                        onChange={(e) => setNodeName(e.target.value)}
                    />
                </div>
                <div>
                    <label>Node Approach/Color:</label>
                    <ChromePicker
                        color={color}
                        onChangeComplete={(color) => setColor(color.hex)}
                    />
                </div>
                <div>
                    <label>Select Type:</label>
                    <select value={type} onChange={(e) => setType(e.target.value)}>
                        <option value="">Select a type</option>
                        <option value="ec">Concept or technique expressly cited</option>
                        <option value="oc">Concept or technique added to ease overall comprehension</option>
                    </select>
                </div>
                <div>
                    <label>Add Citations:</label>
                    <input
                        type="text"
                        value={citationInput}
                        onChange={(e) => setCitationInput(e.target.value)}
                    />
                    <button type="button" onClick={handleAddCitation}>Add</button>
                    <ul>
                        {citations.map((citation, index) => (
                            <li key={index}>
                                {citation}
                                <button type="button" onClick={() => handleRemoveCitation(index)}>Remove</button>
                            </li>
                        ))}
                    </ul>
                </div>
                <div>
                    <label>Add Tags:</label>
                    <input
                        type="text"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                    />
                    <button type="button" onClick={handleAddTag}>Add</button>
                    <ul>
                        {tags.map((tag, index) => (
                            <li key={index}>
                                {tag}
                                <button type="button" onClick={() => handleRemoveTag(index)}>Remove</button>
                            </li>
                        ))}
                    </ul>
                </div>
                <div>
                    <label>Select Map:</label>
                    <select value={selectedMap} onChange={(e) => setSelectedMap(e.target.value)}>
                        <option value="">Select a map</option>
                        {mapOptions.map((map, index) => (
                            <option key={index} value={map}>{map}</option>
                        ))}
                    </select>
                </div>
                <button type="submit">Add Node</button>
            </form>
            {message && <p>{message}</p>}
        </div>
    );
};

export default AddNodeForm;
