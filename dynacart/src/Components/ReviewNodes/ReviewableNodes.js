import React, { useState, useEffect } from 'react';

const ReviewableNodes = () => {
    const [reviewableNodes, setReviewableNodes] = useState([]);
    const [message, setMessage] = useState('');

    useEffect(() => {
        const fetchReviewableNodes = async () => {
            try {
                const response = await fetch('http://localhost:4000/api/reviewable-nodes');
                const data = await response.json();
                setReviewableNodes(data);
            } catch (error) {
                console.error('Error fetching reviewable nodes:', error);
            }
        };

        fetchReviewableNodes();
    }, []);

    const handleConfirmAddition = async (nodeId, nodeProperties, nodeLabel) => {
        try {
            
            const response = await fetch(`http://localhost:4000/api/confirm-node-addition/${nodeId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    label: nodeLabel,
                    properties: nodeProperties,
                }),
            });
    
            if (response.ok) {
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
            const response = await fetch(`http://localhost:4000/api/reject-node-addition/${nodeId}`, {
                method: 'POST',
            });
            if (response.ok) {
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
