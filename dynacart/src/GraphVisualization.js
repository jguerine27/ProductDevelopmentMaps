import React, { useEffect, useState, useRef } from 'react';
import * as d3 from 'd3';
import axios from 'axios';

const GraphVisualization = () => {
    const [data, setData] = useState({ nodes: [], relationships: [] });
    const [selectedMap, setSelectedMap] = useState(null); // State for selected map
    const svgRef = useRef(null); // Ref to SVG element

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, selectedMap]);

    const drawGraph = ({ nodes, relationships }) => {
        const width = 800;
        const height = 800; // Increased height for four rows
        const margin = 20; // Margin to keep nodes within bounds

        const svg = d3.select(svgRef.current)
            .attr('width', width)
            .attr('height', height)
            .style('border', '1px solid #ccc');

        // Create clipping path to keep nodes within bounds
        svg.append('defs').append('clipPath')
            .attr('id', 'clip')
            .append('rect')
            .attr('width', width - margin * 2)
            .attr('height', height - margin * 2)
            .attr('x', margin)
            .attr('y', margin);

        const color = d3.scaleOrdinal(d3.schemeCategory10);

        const linkWidth = d => {
            const linkCount = filteredRelationships.filter(rel => rel.source === d.source && rel.target === d.target).length;
            return Math.min(linkCount * 2, 10);
        };

        // Define rows for Approach, Process, Method, Tool
        const rowPositions = {
            Approach: height / 4 - margin,
            Process: height / 2 - margin,
            Method: height * 3 / 4 - margin,
            Tool: height - margin
        };

        // Filter nodes based on selected map
        const filteredNodes = selectedMap ? nodes.filter(node => node.map === selectedMap) : nodes;

        // Filter relationships to include only those where both source and target nodes are in filteredNodes
        const filteredRelationships = [...relationships].filter(rel => {
            const sourceNode = filteredNodes.find(node => node.name === rel.source);
            const targetNode = filteredNodes.find(node => node.name === rel.target);
            return sourceNode && targetNode; // Include relationship if both source and target nodes are in filteredNodes
        });

        // Initialize simulation
        const simulation = d3.forceSimulation(filteredNodes)
            .force('link', d3.forceLink(filteredRelationships).id(d => d.name).distance(200))
            .force('charge', d3.forceManyBody().strength(-500))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('boundary', boundaryForce(margin, width - margin, margin, height - margin, rowPositions))
            .on('tick', ticked);

        // Remove existing elements
        svg.selectAll('*').remove();

        // Tooltip
        const tooltip = d3.select('body').append('div')
            .attr('class', 'tooltip')
            .style('position', 'absolute')
            .style('background', '#f9f9f9')
            .style('padding', '10px')
            .style('border', '1px solid #d3d3d3')
            .style('border-radius', '5px')
            .style('pointer-events', 'none')
            .style('opacity', 0);

        let tooltipVisible = false;

        // Add links
        const link = svg.append('g')
            .attr('class', 'links')
            .selectAll('line')
            .data(filteredRelationships)
            .enter().append('line')
            .attr('stroke', 'black')
            .attr('stroke-width', linkWidth)
            .on('click', (event, d) => {
                if (tooltipVisible) {
                    hideTooltip();
                } else {
                    showTooltip(event, d);
                }
                tooltipVisible = !tooltipVisible;
            });

        // Add nodes
        const node = svg.append('g')
            .attr('class', 'nodes')
            .selectAll('rect')
            .data(filteredNodes)
            .enter().append('rect')
            .attr('width', 100)
            .attr('height', 40)
            .attr('rx', 5)
            .attr('ry', 5)
            .attr('fill', d => color(d.label))
            .call(d3.drag()
                .on('start', dragstarted)
                .on('drag', dragged)
                .on('end', dragended))
            .attr('clip-path', 'url(#clip)') // Apply clipping path
            .on('click', (event, d) => {
                if (tooltipVisible) {
                    hideTooltip();
                } else {
                    showNodeTooltip(event, d);
                }
                tooltipVisible = !tooltipVisible;
            });

        // Add node labels
        const nodeText = svg.append('g')
            .selectAll('text')
            .data(filteredNodes)
            .enter().append('text')
            .attr('dy', 25)
            .attr('dx', 50)
            .attr('text-anchor', 'middle')
            .text(d => d.name);

        // Function to show tooltip for links
        function showTooltip(event, d) {
            tooltip.transition()
                .duration(200)
                .style('opacity', .9);
            const relationshipNames = filteredRelationships
                .filter(rel => rel.source === d.source && rel.target === d.target)
                .map(rel => rel.name);
            tooltip.html('<ul>' + relationshipNames.map(name => `<li>${name}</li>`).join('') + '</ul>')
                .style('left', (event.pageX + 5) + 'px')
                .style('top', (event.pageY - 28) + 'px');
        }

        // Function to show tooltip for nodes
        function showNodeTooltip(event, d) {
            tooltip.transition()
                .duration(200)
                .style('opacity', .9);

            // Check if citations property exists and is an array
            const citations = d.citations;
            if (Array.isArray(citations)) {
                tooltip.html('<ul>' + citations.map(citation => `<li>${citation}</li>`).join('') + '</ul>')
                    .style('left', (event.pageX + 5) + 'px')
                    .style('top', (event.pageY - 28) + 'px');
            } else {
                tooltip.html('No citations available')
                    .style('left', (event.pageX + 5) + 'px')
                    .style('top', (event.pageY - 28) + 'px');
            }
        }

        // Function to hide tooltip
        function hideTooltip() {
            tooltip.transition()
                .duration(500)
                .style('opacity', 0);
        }

        // Function to update positions on tick
        function ticked() {
            link
                .attr('x1', d => d.source.x)
                .attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x)
                .attr('y2', d => d.target.y);

            node
                .attr('x', d => Math.max(margin, Math.min(width - margin - 100, d.x - 50)))
                .attr('y', d => Math.max(margin, Math.min(height - margin - 40, d.y - 20)));

            nodeText
                .attr('x', d => d.x)
                .attr('y', d => d.y);
        }

        // Drag functions
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

        // Custom force to keep nodes within boundaries
        function boundaryForce(x1, x2, y1, y2, rowPositions) {
            return () => {
                filteredNodes.forEach(d => {
                    const rowTop = rowPositions[d.label] || y1;
                    const rowBottom = rowPositions[d.label] || y2;
                    d.x = Math.max(x1, Math.min(x2, d.x));
                    d.y = Math.max(rowTop + margin, Math.min(rowBottom - margin - 40, d.y));
                });
            };
        }
    };

    // Function to handle dropdown change
    const handleMapChange = async event => {
        setSelectedMap(event.target.value);
        try {
            const response = await axios.get('http://localhost:4000/api/nodes-relationships');
            setData(response.data);
        } catch (error) {
            console.error('Error fetching data:', error);
        }
    };

    // Get distinct map values
    const distinctMaps = [...new Set(data.nodes.map(node => node.map))];

    return (
        <div>
            <h2>Graph Visualization</h2>
            <div>
                <label htmlFor="mapSelect">Select Map:</label>
                <select id="mapSelect" onChange={handleMapChange}>
                    <option value="">All Maps</option>
                    {distinctMaps.map(map => (
                        <option key={map} value={map}>{map}</option>
                    ))}
                </select>
            </div>
            <svg ref={svgRef}></svg>
        </div>
    );
};

export default GraphVisualization;
