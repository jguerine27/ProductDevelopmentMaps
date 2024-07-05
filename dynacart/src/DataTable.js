import React, { useEffect, useState } from 'react';
import axios from 'axios';

const DataTable = () => {
    const [data, setData] = useState([]);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const response = await axios.get('http://localhost:4000/api/nodes-relationships');
                setData(response.data);
            } catch (error) {
                console.error('Error fetching data:', error);
            }
        };

        fetchData();
    }, []);

    return (
        <div>
            <h2>Nodes and Relationships</h2>
            <table>
                <thead>
                    <tr>
                        <th>Start Node</th>
                        <th>Relationship</th>
                        <th>End Node</th>
                    </tr>
                </thead>
                <tbody>
                    {data.map((record, index) => (
                        <tr key={index}>
                            <td>{record.startNode.name}</td>
                            <td>{record.relationship.name}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default DataTable;
