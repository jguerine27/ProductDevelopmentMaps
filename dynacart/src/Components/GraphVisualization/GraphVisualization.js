import React, { useEffect, useState, useRef } from 'react';
import * as d3 from 'd3';
import axios from 'axios';
let detailedView = false;

const GraphVisualization = () => {
    const [data, setData] = useState({ nodes: [], relationships: [] });
    const [selectedMap, setSelectedMap] = useState(null); // State for selected map
    const svgRef = useRef(null); // Ref to SVG element
    const tooltipRef = useRef(null); // Ref to tooltip element

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

        const svg = d3.select(svgRef.current);
        svg.selectAll('*').remove(); // Remove existing elements

        svg.attr('width', width)
            .attr('height', height)
            .style('border', '1px solid #ccc')
            .style('display', 'block') // Ensure SVG behaves like a block element
            .style('margin', 'auto'); // Center the SVG horizontally

        // Create clipping path to keep nodes within bounds
        svg.append('defs').append('clipPath')
            .attr('id', 'clip')
            .append('rect')
            .attr('width', width - margin * 2)
            .attr('height', height - margin * 2)
            .attr('x', margin)
            .attr('y', margin);

        svg.append('defs').append('marker')
    .attr('id', 'arrowhead')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 8)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5');

       // const color = d3.scaleOrdinal(d3.schemeCategory10);

        const linkWidth = d => {
            const linkCount = relationships.filter(rel => rel.source === d.source && rel.target === d.target).length;
            return Math.min(linkCount * 2, 10);
        };

        // Define rows for Approach, Process, Method, Tool
        const rowPositions = {
            'Approach': { top: margin, bottom: height / 4 - margin },
            'Process': { top: height / 4, bottom: height / 2 - margin },
            'Method': { top: height / 2, bottom: (height * 3) / 4 - margin },
            'Tool': { top: (height * 3) / 4, bottom: height - margin }
        };

        // Add boundaries for rows
        Object.values(rowPositions).forEach(pos => {
            svg.append('rect')
                .attr('x', margin)
                .attr('y', pos.top)
                .attr('width', width - 2 * margin)
                .attr('height', pos.bottom - pos.top)
                .attr('fill', 'none')
                .attr('stroke', 'black');
        });

        // Add solid grey lines to partition sections
        const partitionLines = ['Process', 'Method', 'Tool'];
        partitionLines.forEach(section => {
            svg.append('line')
                .attr('x1', margin)
                .attr('y1', rowPositions[section].top)
                .attr('x2', width - margin)
                .attr('y2', rowPositions[section].top)
                .attr('stroke', '#CCC')
                .attr('stroke-width', 12);
        });

        // Add labels on the left-hand side
        svg.append('g')
            .selectAll('text')
            .data(Object.keys(rowPositions))
            .enter().append('text')
            .attr('x', 10) // Adjust as needed for positioning
            .attr('y', d => (rowPositions[d].top + rowPositions[d].bottom) / 2) // Center vertically within each row
            .attr('dy', '0.35em') // Center text vertically
            .attr('font-size', '14px')
            .text(d => d)
            .style('text-anchor', 'start');

        // Filter nodes based on selected map
        const filteredNodes = selectedMap ? nodes.filter(node => node.map === selectedMap) : nodes;

        // Filter relationships to include only those where both source and target nodes are in filteredNodes
        const filteredRelationships = [...relationships].filter(rel => {
            const sourceNode = filteredNodes.find(node => node.name === rel.source);
            const targetNode = filteredNodes.find(node => node.name === rel.target);
            return sourceNode && targetNode; // Include relationship if both source and target nodes are in filteredNodes
        });

        const invertColor = (hex) => {
            hex = String(hex).replace('#', ''); // Ensure hex is a string and remove the # if present
            if (hex.length === 3) {
                hex = hex.split('').map(char => char + char).join(''); // Convert shorthand hex (e.g., #03F) to full form (e.g., #0033FF)
            }
            if (hex.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(hex)) {
                throw new Error('Invalid HEX color.');
            }
            let r = parseInt(hex.slice(0, 2), 16),
                g = parseInt(hex.slice(2, 4), 16),
                b = parseInt(hex.slice(4, 6), 16);
            return '#' + (255 - r).toString(16).padStart(2, '0') + (255 - g).toString(16).padStart(2, '0') + (255 - b).toString(16).padStart(2, '0');
        };
        


        // Initialize simulation
        const simulation = d3.forceSimulation(filteredNodes)
            .force('link', d3.forceLink(filteredRelationships).id(d => d.name).distance(200))
            .force('charge', d3.forceManyBody().strength(-110))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('boundary', boundaryForce(margin, width - margin, margin, height - margin, rowPositions))
            .on('tick', ticked);

        // Tooltip
        const tooltip = d3.select(tooltipRef.current)
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
        .attr('stroke', d => {
            if (d.type === 'ec') {
                return 'black'; // Solid line for "ec"
            } else {
                return 'black'; // Default to black, will override for "oc" and "h"
            }
        })
        .attr('stroke-width', d => {
            if (d.type === 'ec') {
                return linkWidth(d); // Adjust width if needed for "ec"
            } else {
                return linkWidth(d); // Default width, change if needed
            }
        })
        .attr('stroke-dasharray', d => {
            if (d.type === 'oc' || d.type === 'h') {
                return '5,5'; // Dashed line for "oc" and "h"
            } else {
                return 'none'; // Solid line for "ec"
            }
        })
        .attr('marker-end', d => {
            if (d.type === 'h') {
                return 'url(#arrowhead)'; // Arrowhead marker for "h"
            } else {
                return ''; // No marker for others
            }
        })
        .on('click', (event, d) => {
            if (!detailedView){
            if (tooltipVisible) {
                hideTooltip();
            } else {
                showTooltip(event, d);
            }
            tooltipVisible = !tooltipVisible;}

        });
        const linkLabel = svg.append('g')
        .attr('class', 'link-labels')
        .selectAll('text')
        .data(filteredRelationships)
        .enter().append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', -5)
        .attr('font-size', '12px')
        .text(detailedView ? d => d.citations : '');
    

// Add nodes
const node = svg.append('g')
    .attr('class', 'nodes')
    .selectAll('g')
    .data(filteredNodes)
    .enter().append('g')
    .call(d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended))
//    .attr('clip-path', 'url(#clip)') // Apply clipping path
    .on('click', (event, d) => {
        if (!detailedView){
            if (tooltipVisible) {
                hideTooltip();
            } else {
                showNodeTooltip(event, d);
            }
            tooltipVisible = !tooltipVisible;
        }
    });

// Add the main rectangle (90% part)
node.append('rect')
    .attr('width', 90) // 90% of the total width
    .attr('height', 40)
 
    .attr('fill', 'none')
    .attr('stroke', 'black'); // Add stroke for visibility

// Add the color rectangle (10% part)
node.append('rect')
    .attr('x', 90) // Start where the main rectangle ends
    .attr('width', 10) // 10% of the total width
    .attr('height', 40)
    
    .attr('fill', d => d.color || '#000')
    .attr('stroke', 'black'); // Add stroke for visibility

// Update node labels inside nodes
const nodeText = node.append('text')
    .attr('class', 'node-label')
    .attr('x', 45) // Centered within the 90% rectangle
    .attr('y', 20) // Centered vertically
    .attr('dy', '0.35em') // Center text vertically
    .attr('text-anchor', 'middle')
    .attr('font-size', '12px')
    .attr('fill', 'black')
    .attr('font-weight', 'bold')
    .text(d => detailedView ? d.name + d.citations : d.name);
    
        // Function to show tooltip for links

        function showTooltip(event, d) {
            tooltip.transition()
                .duration(200)
                .style('opacity', .9);
            const relationshipNames = filteredRelationships
                .filter(rel => rel.source === d.source && rel.target === d.target)
                .map(rel => rel.name);
            tooltip.html('<ul>' + relationshipNames.map(name => `<li>${name}</li><br>`).join('') + '</ul>')
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
            if (Array.isArray(citations) && citations.length > 0) {
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
        
// Function to update positions on tick
function ticked() {
    link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

    linkLabel
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2);

    node
        .attr('transform', d => `translate(${Math.max(margin, Math.min(width - margin - 100, d.x - 50))}, ${Math.max(rowPositions[d.label].top + margin, Math.min(rowPositions[d.label].bottom - margin - 40, d.y - 20))})`);

    nodeText
        .attr('x', 45) // Centered within the 90% rectangle
        .attr('y', 20); // Centered vertically
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
                    const rowTop = rowPositions[d.label].top;
                    const rowBottom = rowPositions[d.label].bottom;
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

    const toggleView = () => {
    handleMapChange({ target: { value: selectedMap } });
    detailedView = !detailedView;
    console.log(detailedView);

     }
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
            <div ref={tooltipRef}></div>
            <button onClick={toggleView}>Toggle View</button>
        </div>
    );
};

export default GraphVisualization;
