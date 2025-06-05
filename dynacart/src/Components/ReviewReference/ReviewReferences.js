import React, { useState, useEffect } from 'react';

const ReviewReferences = () => {
    const [reviewableReferences, setReviewableReferences] = useState([]);
    const [message, setMessage] = useState('');

    useEffect(() => {
        const fetchReviewableReferences = async () => {
            try {
                const response = await fetch('http://localhost:4000/api/reviewable-references');
                const data = await response.json();
                setReviewableReferences(data);
            } catch (error) {
                console.error('Error fetching reviewable references:', error);
            }
        };

        fetchReviewableReferences();
    }, []);

    const handleConfirmAddition = async (reference,referenceId) => {
        try {
            const response = await fetch(`http://localhost:4000/api/confirm-reference-addition/${referenceId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    ...reference, // Include all properties
                }),
            });
            if (response.ok) {
                setMessage('Reference added to the database.');
                setReviewableReferences(reviewableReferences.filter(reference => reference.id !== referenceId));
            } else {
                setMessage('Failed to add reference to the database.');
            }
        } catch (error) {
            console.error('Error confirming reference addition:', error);
        }
    };

    const handleRejectAddition = async (referenceId) => {
        try {
            const response = await fetch(`http://localhost:4000/api/reject-reference-addition/${referenceId}`, {
                method: 'POST',
            });
            if (response.ok) {
                setMessage('Reference rejected.');
                setReviewableReferences(reviewableReferences.filter(reference => reference.id !== referenceId));
            } else {
                setMessage('Failed to reject reference.');
            }
        } catch (error) {
            console.error('Error rejecting reference addition:', error);
        }
    };

    return (
        <div>
            <h2>Reviewable References</h2>
            {message && <p>{message}</p>}
            <ul>
                {reviewableReferences.map(reference => (
                    <li key={reference.id}>
                        <p><strong>{reference.name}</strong> - {reference.referenceName}</p>
                        <p><strong>Year:</strong> {reference.year}</p>
                        <p><strong>Author:</strong> {reference.author}</p>
                        <p><strong>Type:</strong> {reference.type}</p>
                        <button onClick={() => handleConfirmAddition(reference,reference.referenceName)}>Confirm addition</button>
                        <button onClick={() => handleRejectAddition(reference.referenceName)}>Reject addition</button>
                    </li>
                ))}
            </ul>
        </div>
    );
};

export default ReviewReferences;
