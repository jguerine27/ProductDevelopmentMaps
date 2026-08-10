import React, { useState, useEffect } from 'react';
import './DeleteOption.css'; // Import the CSS file for styling
import apiClient from '../../api/client';

const DeleteOption = () => {
    const [nodes, setNodes] = useState([]);
    const [relationships, setRelationships] = useState([]);
    const [message, setMessage] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(null);

    useEffect(() => {
        const fetchNodesAndRelationships = async () => {
            try {
                const response = await apiClient.get('/api/nodes-relationships');
                const data = response.data;
                setNodes(data.nodes);
                setRelationships(data.relationships);
            } catch (error) {
                console.error('Error fetching nodes and relationships:', error);
            }
        };

        fetchNodesAndRelationships();
    }, []);

    const handleDeleteNode = async (nodeName) => {
        try {
            const response = await apiClient.delete(`/api/delete-node/${nodeName}`);
            if (response.status === 200) {
                setNodes(nodes.filter(node => node.name !== nodeName));
                setMessage('Node deleted successfully.');
            } else {
                setMessage('Failed to delete node.');
            }
        } catch (error) {
            console.error('Error deleting node:', error);
        }
    };

    const handleDeleteRelationship = async (relationshipName) => {
        try {
            const response = await apiClient.delete(`/api/delete-relationship/${relationshipName}`);
            if (response.status === 200) {
                setRelationships(relationships.filter(relationship => relationship.name !== relationshipName));
                setMessage('Relationship deleted successfully.');
            } else {
                setMessage('Failed to delete relationship.');
            }
        } catch (error) {
            console.error('Error deleting relationship:', error);
        }
    };

    const confirmDeleteAction = (type, name) => {
        setConfirmDelete({ type, name });
    };

    const cancelDeleteAction = () => {
        setConfirmDelete(null);
    };

    const executeDeleteAction = () => {
        if (confirmDelete) {
            if (confirmDelete.type === 'node') {
                handleDeleteNode(confirmDelete.name);
            } else if (confirmDelete.type === 'relationship') {
                handleDeleteRelationship(confirmDelete.name);
            }
            setConfirmDelete(null);
        }
    };

    return (
        <div className="containeri">
            <h2 className="title">Delete Nodes and Relationships</h2>
            {message && <p className="message">{message}</p>}
            <div className="table-wrapper">
                <div className="table-container">
                    <h3 className="table-title">Nodes</h3>
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Label</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {nodes.map(node => (
                                <tr key={node.name}>
                                    <td>{node.name}</td>
                                    <td>{node.label}</td>
                                    <td>
                                        <button className="delete-button" onClick={() => confirmDeleteAction('node', node.name)}>Delete</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="table-container">
                    <h3 className="table-title">Relationships</h3>
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Source</th>
                                <th>Target</th>
                                <th>Name</th>
                                <th>Type</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {relationships.map(relationship => (
                                <tr key={relationship.name}>
                                    <td>{relationship.source}</td>
                                    <td>{relationship.target}</td>
                                    <td>{relationship.name}</td>
                                    <td>{relationship.type}</td>
                                    <td>
                                        <button className="delete-button" onClick={() => confirmDeleteAction('relationship', relationship.name)}>Delete</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {confirmDelete && (
                <div className="modal-overlay">
                    <div className="modal">
                        <p>Are you sure you want to delete this {confirmDelete.type}?</p>
                        <button className="confirm-button" onClick={executeDeleteAction}>Confirm</button>
                        <button className="cancel-button" onClick={cancelDeleteAction}>Cancel</button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DeleteOption;
