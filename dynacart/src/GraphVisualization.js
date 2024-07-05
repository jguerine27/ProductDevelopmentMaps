import React, { useEffect, useState } from 'react';
import * as d3 from 'd3';
import axios from 'axios';

const GraphVisualization = () => {
    const [data, setData] = useState({ nodes: [], relationships: [] });

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

    useEffect(() => {
        if (data.nodes.length > 0) {
            drawGraph(data);
        }
    }, [data]);

    const drawGraph = ({ nodes, relationships }) => {
        const width = 800;
        const height = 600;

        const svg = d3.select('#graph')
            .attr('width', width)
            .attr('height', height);

        const color = d3.scaleOrdinal(d3.schemeCategory10);

        const simulation = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(relationships).id(d => d.name).distance(200))
            .force('charge', d3.forceManyBody().strength(-500))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .on('tick', ticked);

        svg.selectAll('*').remove();

        const link = svg.append('g')
            .attr('class', 'links')
            .selectAll('line')
            .data(relationships)
            .enter().append('line')
            .attr('stroke', 'black')
            .attr('stroke-width', 2);

        const linkText = svg.append('g')
            .selectAll('text')
            .data(relationships)
            .enter().append('text')
            .attr('dy', -3)
            .attr('text-anchor', 'middle')
            .text(d => d.name);

        const node = svg.append('g')
            .attr('class', 'nodes')
            .selectAll('rect')
            .data(nodes)
            .enter().append('rect')
            .attr('width', 100)
            .attr('height', 40)
            .attr('rx', 5)
            .attr('ry', 5)
            .attr('fill', d => color(d.label))
            .call(d3.drag()
                .on('start', dragstarted)
                .on('drag', dragged)
                .on('end', dragended));

        const nodeText = svg.append('g')
            .selectAll('text')
            .data(nodes)
            .enter().append('text')
            .attr('dy', 25)
            .attr('dx', 50)
            .attr('text-anchor', 'middle')
            .text(d => d.name);

        function ticked() {
            link
                .attr('x1', d => d.source.x)
                .attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x)
                .attr('y2', d => d.target.y);

            linkText
                .attr('x', d => (d.source.x + d.target.x) / 2)
                .attr('y', d => (d.source.y + d.target.y) / 2);

            node
                .attr('x', d => d.x - 50)
                .attr('y', d => d.y - 20);

            nodeText
                .attr('x', d => d.x)
                .attr('y', d => d.y);
        }

        function dragstarted(event, d) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        }

        function dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        }

        function dragended(event, d) {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        }
    };

    return (
        <div>
            <h2>Graph Visualization</h2>
            <svg id="graph"></svg>
        </div>
    );
};

export default GraphVisualization;
