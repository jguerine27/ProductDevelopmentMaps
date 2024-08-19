import React, { useState, useEffect } from 'react';
import { ChromePicker } from 'react-color';
import './AddNodeForm.css';

const AddNodeForm = () => {
    const [nodeLabels, setNodeLabels] = useState([]);
    const [selectedLabel, setSelectedLabel] = useState('');
    const [nodeName, setNodeName] = useState('');
    const [approaches, setApproaches] = useState([]);
    const [approachColorDict, setApproachColorDict] = useState({});
    const [selectedApproach, setSelectedApproach] = useState('');
    const [newApproach, setNewApproach] = useState('');
    const [newColor, setNewColor] = useState('#000000');
    const [type, setType] = useState('');
    const [citations, setCitations] = useState([]);
    const [citationInput, setCitationInput] = useState('');
    const [tags, setTags] = useState([]);
    const [tagInput, setTagInput] = useState('');
    const [mapOptions, setMapOptions] = useState([]);
    const [selectedMap, setSelectedMap] = useState('');
    const [newMapName, setNewMapName] = useState('');
    const [message, setMessage] = useState('');

    useEffect(() => {
        const fetchData = async () => {
            try {
                const [labelsResponse, mapsResponse, approachesResponse, colorsResponse] = await Promise.all([
                    fetch('http://localhost:4000/api/node-labels'),
                    fetch('http://localhost:4000/api/node-maps'),
                    fetch('http://localhost:4000/api/get-approaches'),
                    fetch('http://localhost:4000/api/get-colors')
                ]);

                if (labelsResponse.ok && mapsResponse.ok && approachesResponse.ok && colorsResponse.ok) {
                    const labels = await labelsResponse.json();
                    const maps = await mapsResponse.json();
                    const approaches = await approachesResponse.json();
                    const colors = await colorsResponse.json();

                    // Create approach to color dictionary
                    const approachColorDict = approaches.reduce((dict, approach, index) => {
                        dict[approach] = colors[index];
                        return dict;
                    }, {});

                    setNodeLabels(labels);
                    setMapOptions(maps);
                    setApproaches(approaches);
                    setApproachColorDict(approachColorDict);
                } else {
                    throw new Error('Failed to fetch data');
                }
            } catch (error) {
                console.error('Error fetching data:', error);
            }
        };

        fetchData();
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
        if (!selectedLabel || !nodeName || !selectedApproach || !type || !selectedMap) {
            setMessage('Please fill in all required fields.');
            return;
        }

        // Determine color to submit
        let colorToSubmit;
        if (selectedApproach === 'New Approach') {
            colorToSubmit = newColor;
        } else {
            colorToSubmit = approachColorDict[selectedApproach];
        }

        // Include newMapName in request body if "New Map" is selected
        const mapToSubmit = selectedMap === 'New Map' ? newMapName : selectedMap;

        try {
            const response = await fetch('http://localhost:4000/api/submit-node-for-review', {
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
                    map: mapToSubmit,
                    color: colorToSubmit,
                    approach: selectedApproach === 'New Approach' ? newApproach : selectedApproach
                }),
            });

            const data = await response.json();
            setMessage(data.message || 'Node submitted for review');
        } catch (error) {
            console.error('Error submitting node for review:', error);
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
                    <label>Node Approach:</label>
                    <select value={selectedApproach} onChange={(e) => {
                        const value = e.target.value;
                        if (value === 'New Approach') {
                            setNewApproach('');
                            setNewColor('#000000'); // Reset color picker
                        } else {
                            setSelectedApproach(value);
                            setNewApproach(''); // Clear new approach name
                        }
                        setSelectedApproach(value);
                    }}>
                        <option value="">Select an approach</option>
                        {approaches.map((approach, index) => (
                            <option key={index} value={approach}>
                                {approach}
                            </option>
                        ))}
                        <option value="New Approach">New Approach</option>
                    </select>
                    {selectedApproach === 'New Approach' && (
                        <div>
                            <label>Pick a New Color:</label>
                            <ChromePicker
                                color={newColor}
                                onChangeComplete={(color) => setNewColor(color.hex)}
                            />
                            <label>New Approach Name:</label>
                            <input
                                type="text"
                                value={newApproach}
                                onChange={(e) => setNewApproach(e.target.value)}
                                placeholder="Enter new approach name"
                            />
                        </div>
                    )}
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
                    <select value={selectedMap} onChange={(e) => {
                        const value = e.target.value;
                        setSelectedMap(value);
                        if (value === 'New Map') {
                            setNewMapName('');
                        }
                    }}>
                        <option value="">Select a map</option>
                        {mapOptions.map((map, index) => (
                            <option key={index} value={map}>{map}</option>
                        ))}
                        <option value="New Map">New Map</option>
                    </select>
                    {selectedMap === 'New Map' && (
                        <div>
                            <label>New Map Name:</label>
                            <input
                                type="text"
                                value={newMapName}
                                onChange={(e) => setNewMapName(e.target.value)}
                            />
                        </div>
                    )}
                </div>
                <button type="submit">Add Node</button>
            </form>
            {message && <p>{message}</p>}
        </div>
    );
};

export default AddNodeForm;
