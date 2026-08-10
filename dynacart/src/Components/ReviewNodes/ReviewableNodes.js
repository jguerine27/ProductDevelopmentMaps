import React, { useState, useEffect } from 'react';
import apiClient from '../../api/client';

const ReviewableNodes = () => {
    const [reviewableNodes, setReviewableNodes] = useState([]);
    const [message, setMessage] = useState('');

    useEffect(() => {
        const fetchReviewableNodes = async () => {
            try {
                const response = await apiClient.get('/api/reviewable-nodes');
                const data = response.data;
                setReviewableNodes(data);
            } catch (error) {
                console.error('Error fetching reviewable nodes:', error);
            }
        };

        fetchReviewableNodes();
    }, []);

    const handleConfirmAddition = async (nodeId, nodeProperties, nodeLabel) => {
        try {
            
            const response = await apiClient.post(`/api/confirm-node-addition/${nodeId}`, {
                label: nodeLabel,
                properties: nodeProperties,
            });

            if (response.status === 200) {
                console.log(nodeProperties)
                setMessage('Node added to the database.');
                setReviewableNodes(reviewableNodes.filter(node => node.id !== nodeId));
                
            } else {
                setMessage('Failed to add node to the database.');
            }
        } catch (error) {
            console.error('Error confirming node addition:', error);
        }
    };
    

    const handleRejectAddition = async (nodeId) => {
        try {
            const response = await apiClient.post(`/api/reject-node-addition/${nodeId}`);
            if (response.status === 200) {
                setMessage('Node rejected.');
                setReviewableNodes(reviewableNodes.filter(node => node.id !== nodeId));
            } else {
                setMessage('Failed to reject node.');
            }
        } catch (error) {
            console.error('Error rejecting node addition:', error);
        }
    };

    return (
        <div>
            <h2>Reviewable Nodes</h2>
            {message && <p>{message}</p>}
            <ul>
                {reviewableNodes.map(node => (
                    <li key={node.id}>
                        <p><strong>{node.name}</strong> - {node.label}</p>
                        <button onClick={() => handleConfirmAddition(node.name,node,node.label)}>Confirm addition</button>
                        <button onClick={() => handleRejectAddition(node.name)}>Reject addition</button>
                    </li>
                ))}
            </ul>
        </div>
    );
};

export default ReviewableNodes;
