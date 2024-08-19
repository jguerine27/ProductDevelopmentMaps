import React, { useEffect, useState, useRef } from 'react';
import * as d3 from 'd3';
import axios from 'axios';
import './GraphVisualization.css'
import { saveAs } from 'file-saver'; // For file download
import Papa from 'papaparse'; // For CSV export
import { toPng } from 'html-to-image'; // For PNG export
import jsPDF from 'jspdf'; // For PDF export

//import { set } from '../../../../backend';
let detailedView = false;


const GraphVisualization = () => {
    const [data, setData] = useState({ nodes: [], relationships: [] });
    const [selectedMap, setSelectedMap] = useState(null); // State for selected map
    const svgRef = useRef(null); // Ref to SVG element
    const tooltipRef = useRef(null); // Ref to tooltip element
    const [showExportOptions, setShowExportOptions] = useState(false);


    //Filter capabilities
    const [keyword, setKeyword] = useState('');
    const [year, setYear] = useState('');
    const [startYear, setStartYear] = useState('');
    const [endYear, setEndYear] = useState('');
    const [author, setAuthor] = useState('');
    const [tag, setTag] = useState('');
    const [color, setColor] = useState('');
    const [isYearInputActive, setIsYearInputActive] = useState(false);
    const [isYearRangeInputActive, setIsYearRangeInputActive] = useState(false);

    // Update the state based on inputs
    useEffect(() => {
        setIsYearInputActive(year.length > 0);
        setIsYearRangeInputActive(startYear !== '' || endYear !== '');
    }, [year, startYear, endYear]);

    const [years, setYears] = useState([]);
    const [references, setReferences] = useState([]);
    const [tags, setTags] = useState([]);
    const [colors, setColors] = useState([]);
    const [approaches, setApproaches] = useState([]);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const response = await axios.get(process.env.REACT_APP_BACKEND+'/api/nodes-relationships');
                setData(response.data);
                const [yearsRes, referencesRes, tagsRes, colorsRes, approachesRes] = await Promise.all([
                    axios.get(process.env.REACT_APP_BACKEND+'/api/get-years'),
                    axios.get(process.env.REACT_APP_BACKEND+'/api/get-authors'),
                    axios.get(process.env.REACT_APP_BACKEND+'/api/get-tags'),
                    axios.get(process.env.REACT_APP_BACKEND+'/api/get-colors'),
                    axios.get(process.env.REACT_APP_BACKEND+'/api/get-approaches')
                ]);

                // Assuming API responses are arrays
                setYears(yearsRes.data);
                setReferences(referencesRes.data);
                setTags(tagsRes.data);
                setColors(colorsRes.data);
                setApproaches(approachesRes.data);
            } catch (error) {
                console.error('Error fetching data:', error);
            }
        };

        fetchData();
    }, []);

    useEffect(() => {
        if (data.nodes.length > 0) {
            console.log(data)
            drawGraph(data);
                // You can also update the state or perform other actions here
           
        }
       
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, selectedMap]);

    
    const handleExportCSV = () => {
        // Assuming 'data.nodes' contains the current data displayed on the website
        const filteredData = data.nodes.map(node => {
            return {
                Name: node.name,
                Label: node.label,
                Approach: node.approach,
                Map: node.map,
                Type: node.type,
                color: node.color,
                citation: (node.citation || []).concat(node.citations || []).join('; '), // Merge 'citation' and 'citations'
                tags: (node.tags || []).join(', ') // Join tags array into a string
            };
        });
    
        // Convert filtered data to CSV
        const csvData = Papa.unparse(filteredData);
    
        // Trigger CSV download
        const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
        saveAs(blob, 'graph_data.csv');
    };
    

    const handleExportPNG = () => {
        const svgElement = document.querySelector('svg');
        const originalBackground = svgElement.style.backgroundColor; // Store original background color
    
        // Set the background color to white
        svgElement.style.backgroundColor = 'white';
    
        toPng(svgElement)
            .then((dataUrl) => {
                const link = document.createElement('a');
                link.download = 'graph_image.png';
                link.href = dataUrl;
                link.click();
            })
            .catch((error) => console.error('Error exporting as PNG:', error))
            .finally(() => {
                // Revert to the original background color
                svgElement.style.backgroundColor = originalBackground;
            });
    };
    const handleExportPDF = () => {
        const svgElement = document.querySelector('svg');
        const originalBackground = svgElement.style.backgroundColor; // Store original background color
    
        // Set the background color to white
        svgElement.style.backgroundColor = 'white';
    
        const svgString = new XMLSerializer().serializeToString(svgElement);
        const DOMURL = window.URL || window.webkitURL || window;
        const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const url = DOMURL.createObjectURL(svgBlob);
    
        const img = new Image();
        img.onload = function () {
            // Create a canvas with the dimensions of the SVG's viewBox
            const canvas = document.createElement('canvas');
            const svgRect = svgElement.getBoundingClientRect();
            canvas.width = svgRect.width;
            canvas.height = svgRect.height;
            const context = canvas.getContext('2d');
            context.fillStyle = 'white'; // Ensure the background is white
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(img, 0, 0);
    
            // Create a PDF with the same dimensions as the canvas
            const pdf = new jsPDF({
                orientation: 'portrait',
                unit: 'px',
                format: [canvas.width, canvas.height]
            });
    
            const imgData = canvas.toDataURL('image/png');
            pdf.addImage(imgData, 'PNG', 0, 0, canvas.width - 250 , canvas.height);
            pdf.save('graph_image.pdf');
    
            // Revert to the original background color
            svgElement.style.backgroundColor = originalBackground;
            DOMURL.revokeObjectURL(url);
        };
    
        img.src = url;
    };
    

    
    const drawGraph = ({ nodes, relationships }) => {

        const width = window.innerWidth - 50;
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

        function wrapText(text, width) {
            text.each(function() {
                const textElement = d3.select(this);
                const words = textElement.text().split(/\s+/).reverse();
                let line = [];
                let lineNumber = 0;
                const lineHeight = 1.1; // Adjust line height as needed
                const y = parseFloat(textElement.attr("y"));
                const x = parseFloat(textElement.attr("x"));
                let tspan = textElement.text(null).append("tspan").attr("x", x).attr("y", y).attr("dy", `${lineNumber * lineHeight}em`);
        
                let word;
                while ((word = words.pop())) {
                    line.push(word);
                    tspan.text(line.join(" "));
                    if (tspan.node().getComputedTextLength() > width) {
                        line.pop();
                        tspan.text(line.join(" "));
                        line = [word];
                        tspan = textElement.append("tspan").attr("x", x).attr("y", y).attr("dy", `${++lineNumber * lineHeight}em`).text(word);
                    }
                }
            });
        }
        
        
     


        // Initialize simulation
        const simulation = d3.forceSimulation(filteredNodes)
            .force('link', d3.forceLink(filteredRelationships).id(d => d.name).distance(220))
            .force('charge', d3.forceManyBody().strength(-150))
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
// Track label counts for each link
const labelCounts = new Map();
filteredRelationships.forEach(rel => {
    const key = `${rel.source.id}-${rel.target.id}`;
    if (!labelCounts.has(key)) {
        labelCounts.set(key, 0);
    }
    labelCounts.set(key, labelCounts.get(key) + 1);
});

// Create rectangles for references at the middle of each link
const linkReferences = svg.append('g')
    .attr('class', 'link-references')
    .selectAll('rect')
    .data(filteredRelationships)
    .enter().append('rect')
    .attr('x', d => (d.source.x + d.target.x) / 2 - 50)
    .attr('y', d => {
        const key = `${d.source.id}-${d.target.id}`;
        return (d.source.y + d.target.y) / 2 + (labelCounts.get(key) * 10) / 2;
    })
    .attr('width', 100)
    .attr('height', d => {
        const key = `${d.source.id}-${d.target.id}`;
        return labelCounts.get(key) * 20;
    })
    .attr('fill', 'white')
    .attr('stroke', 'white')
    .attr('opacity', 0) // Hide the rectangles
    .style('pointer-events', 'none');

// Add text for references inside the rectangles
let referenceText = svg.append('g')
    .attr('class', 'reference-text')
    .selectAll('text')
    .data(filteredRelationships)
    .enter().append('text')
    .attr('x', d => (d.source.x + d.target.x) / 2)
    .attr('y', (d, i) => {
        const key = `${d.source.id}-${d.target.id}`;
        const index = Array.from(filteredRelationships).filter(rel => `${rel.source.id}-${rel.target.id}` === key).indexOf(d);
        return (d.source.y + d.target.y) / 2 - (labelCounts.get(key) * 10) / 2 + 14 + (index * 20);
    })
    .attr('font-size', '12px')
    .attr('fill', 'white')
    .attr('text-anchor', 'middle')
    .attr('opacity', 0) // Hide the text
    .text(d => d.name);

    function getClosestPointOnRectangle(node, target) {
        // Assuming node is a rectangle with width 90 and height 40
        const rectWidth = 90;
        const rectHeight = 40;
        
        // Center of the node
        const cx = node.x;
        const cy = node.y;
        
        // Rectangle edges
        const left = cx - rectWidth / 2; // Left edge
        const right = cx + rectWidth / 2; // Right edge
        const top = cy - rectHeight / 2; // Top edge
        const bottom = cy + rectHeight / 2; // Bottom edge
        
        // Calculate distances to each edge
        const dx = Math.max(left, Math.min(target.x, right));
        const dy = Math.max(top, Math.min(target.y, bottom));
        
        return { x: dx, y: dy };
    }
    
        

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
    .text(d => detailedView && d.citations != null ? d.name + '\n\n' + d.citations : d.name)
    .call(wrapText, 90); // Wrap text within 90 units width
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

     function ticked() {
    link
        .attr('x1', d => {
            const pos = getClosestPointOnRectangle(d.source, { x: d.target.x, y: d.target.y });
            return pos.x;
        })
        .attr('y1', d => {
            const pos = getClosestPointOnRectangle(d.source, { x: d.target.x, y: d.target.y });
            return pos.y;
        })
        .attr('x2', d => {
            const pos = getClosestPointOnRectangle(d.target, { x: d.source.x, y: d.source.y });
            return pos.x;
        })
        .attr('y2', d => {
            const pos = getClosestPointOnRectangle(d.target, { x: d.source.x, y: d.source.y });
            return pos.y;
        });

    node
        .attr('transform', d => `translate(${Math.max(margin, Math.min(width - margin - 90, d.x - 45))}, ${Math.max(rowPositions[d.label].top + margin, Math.min(rowPositions[d.label].bottom - margin - 40, d.y - 20))})`);
    
    nodeText
        .attr('x', 45) // Centered within the 90% rectangle
        .attr('y', 20); // Centered vertically

    if (detailedView) {
        linkReferences.attr('x', d => (d.source.x + d.target.x) / 2 - 50)
            .attr('y', d => {
                const key = `${d.source.id}-${d.target.id}`;
                return (d.source.y + d.target.y) / 2 - (labelCounts.get(key) * 10) / 2;
            })
            .attr('height', d => {
                const key = `${d.source.id}-${d.target.id}`;
                return labelCounts.get(key) * 20;
            });

        linkReferences.attr('opacity', 0.1); // Show the rectangles

        referenceText.attr('x', d => (d.source.x + d.target.x) / 2)
            .attr('y', (d, i) => {
                const key = `${d.source.id}-${d.target.id}`;
                const index = Array.from(filteredRelationships).filter(rel => `${rel.source.id}-${rel.target.id}` === key).indexOf(d);
                return (d.source.y + d.target.y) / 2 - (labelCounts.get(key) * 10) / 2 + 14 + (index * 20);
            });

        referenceText.attr('fill', 'black'); // Show the text
        referenceText.attr('opacity', 1);
    }
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
            const response = await axios.get(process.env.REACT_APP_BACKEND+'/api/nodes-relationships');
            setData(response.data);
        } catch (error) {
            console.error('Error fetching data:', error);
        }
    };

    //Filter
    const fetchFilteredData = async (url, params) => {
        try {
            const response = await axios.get(url, { params });
            const data = response.data;
            
            if (data.nodes.length === 0) {
                showPopup('No results found! Try again');
            }
            else{
            setData(data)
            }
        } catch (error) {
            console.error('Error fetching filtered data:', error);
        }
    };
    
    const handleFilterByKeyword = () => {
        console.log(keyword);
        fetchFilteredData(process.env.REACT_APP_BACKEND+'/api/filter/keyword/' + keyword);
    };
    
    const handleFilterByYear = () => {
        console.log(year);
        fetchFilteredData(process.env.REACT_APP_BACKEND+'/api/filter/year/' + year );
    };
    
    const handleFilterByYearRange = () => {
        console.log(startYear, endYear);
        fetchFilteredData(process.env.REACT_APP_BACKEND+'/api/filter/yearrange', { startYear, endYear });
    };
    
    const handleFilterByAuthor = () => {
        console.log(author);
        fetchFilteredData(process.env.REACT_APP_BACKEND+'/api/filter/author-reference/' + author);
    };
    
    const handleFilterByTag = () => {
        console.log(tag)
        fetchFilteredData(process.env.REACT_APP_BACKEND+'/api/filter/tag/' + tag);
    };
    
    const handleFilterByColor = () => {
        // Assuming color is an array of color strings
        const sanitizedColors = color.map(c => c.replace('#', ''));
        const sanitizedColorString = sanitizedColors.join(',');
        console.log(sanitizedColorString);
        fetchFilteredData(process.env.REACT_APP_BACKEND+'/api/filter/color/' + sanitizedColorString);
    };
    

    // Get distinct map values
    const distinctMaps = [...new Set(data.nodes.map(node => node.map))];

    const toggleView = () => {
        handleMapChange({ target: { value: selectedMap } });
        detailedView = !detailedView;
        console.log(detailedView);
    };
    const handleApplyAllFilters = async () => {
        try {
            const response = await axios.get(process.env.REACT_APP_BACKEND+'/api/filter/all', {
                params: {
                    keyword: keyword || "",
                    year: year.length ? year : "",
                    startYear: startYear || "",
                    endYear: endYear || "",
                    author: author.length ? author : "",
                    tags: tag.length ? tag : "",
                    color: color.length ? color : "",
                }
            });
            console.log(response.data);
            if (response.data.nodes.length > 0){
    
            // Update your graph visualization with the returned nodes and relationships
            setData(response.data);}
            else{
                showPopup("No results found!")
                const response = await axios.get(process.env.REACT_APP_BACKEND+'/api/nodes-relationships');
                setData(response.data);

            }
        } catch (error) {
            console.error('Error applying all filters:', error);
        }
    };
    const handleResetFilters = async () => {
        // Reset all filter states
        setKeyword('');
        setYear([]);
        setStartYear('');
        setEndYear('');
        setAuthor([]);
        setTag([]);
        setColor([]);
    
        try {
            // Fetch all nodes and relationships without any filters
            const response = await axios.get(process.env.REACT_APP_BACKEND+'/api/filter/all', {
                params: {
                    keyword: '',
                    year: '',
                    startYear: '',
                    endYear: '',
                    author: '',
                    tags: '',
                    color: ''
                }
            });
            const { nodes, relationships } = response.data;
            // Update your graph visualization with the returned nodes and relationships
            setData({ nodes, relationships });
        } catch (error) {
            console.error('Error resetting filters:', error);
        }
    };
    function showPopup(message) {
        const popup = document.getElementById('popup-notification');
        popup.textContent = message;
        popup.classList.remove('hidden');
        popup.classList.add('popup');
        popup.classList.add('show');
    
        setTimeout(() => {
            popup.classList.remove('show');
            setTimeout(() => {
                popup.classList.add('hidden');
            }, 500); // Wait for the fade-out transition to complete
        }, 2500); // Popup will be visible for 5 seconds
    }
    
    // Usage example:
    // showPopup('No result found');
    
    return (
        <div>
            
            <div id="popup-notification" class="hidden">No result found</div>
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
            <form onSubmit={(e) => { e.preventDefault(); handleFilterByKeyword(); }}>
                <input 
                    type="text" 
                    value={keyword} 
                    onChange={(e) => setKeyword(e.target.value)} 
                    placeholder="Filter by keyword" 
                />
                <button type="submit">Apply</button>
            </form>
            <form onSubmit={(e) => { e.preventDefault(); handleFilterByYear(); }}>
                <fieldset>
                    <legend>Filter by Year</legend>
                    <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                        {years.map(y => (
                            <span key={y} style={{ margin: '0 10px 10px 0' }}>
                                <input 
                                    type="checkbox" 
                                    value={y} 
                                    checked={year.includes(y)}
                                    onChange={(e) => {
                                        const selected = e.target.checked;
                                        setYear(prev => 
                                            selected 
                                                ? [...prev, y] 
                                                : prev.filter(item => item !== y)
                                        );
                                    }}
                                    disabled={isYearRangeInputActive}
                                />
                                {y}
                            </span>
                        ))}
                    </div>
                </fieldset>
                <button type="submit">Apply</button>
            </form>
            <form onSubmit={(e) => { 
    e.preventDefault(); 
    handleFilterByYearRange(); 
}}>
    <input 
        type="text" 
        value={startYear} 
        onChange={(e) => {
            const value = e.target.value;
        
            if (value.length < 4) {
                setStartYear(value); // Allow input for the first 3 digits
            } else if (value.length === 4) {
                const numericValue = parseInt(value, 10);
                if (numericValue >= Math.min(...years)) {
                    setStartYear(value);
                } else {
                    showPopup(`Start year cannot be less than ${Math.min(...years)}`);
                }
            }
        }}
        
        placeholder={`Filter by start year (min: ${Math.min(...years)})`} 
        disabled={isYearInputActive}
    />
    <input 
        type="text" 
        value={endYear} 
        onChange={(e) => {
            const value = e.target.value;
            if (value <= Math.max(...years)) {
                setEndYear(value);
            } else {
                showPopup(`End year cannot be greater than ${Math.max(...years)}`);
            }
        }} 
        placeholder={`Filter by end year (max: ${Math.max(...years)})`} 
        disabled={isYearInputActive}
    />
    <button type="submit">Apply</button>
</form>

            <form onSubmit={(e) => { e.preventDefault(); handleFilterByAuthor(); }}>
                <fieldset>
                    <legend>Filter by Author/Reference</legend>
                    <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                        {references.map(ref => (
                            <span key={ref} style={{ margin: '0 10px 10px 0' }}>
                                <input 
                                    type="checkbox" 
                                    value={ref} 
                                    checked={author.includes(ref)}
                                    onChange={(e) => {
                                        const selected = e.target.checked;
                                        setAuthor(prev => 
                                            selected 
                                                ? [...prev, ref] 
                                                : prev.filter(item => item !== ref)
                                        );
                                    }}
                                />
                                {ref}
                            </span>
                        ))}
                    </div>
                </fieldset>
                <button type="submit">Apply</button>
            </form>
    
            <form onSubmit={(e) => { e.preventDefault(); handleFilterByTag(); }}>
                <fieldset>
                    <legend>Filter by Tag</legend>
                    <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                        {tags.map(t => (
                            <span key={t} style={{ margin: '0 10px 10px 0' }}>
                                <input 
                                    type="checkbox" 
                                    value={t} 
                                    checked={tag.includes(t)}
                                    onChange={(e) => {
                                        const selected = e.target.checked;
                                        setTag(prev => 
                                            selected 
                                                ? [...prev, t] 
                                                : prev.filter(item => item !== t)
                                        );
                                    }}
                                />
                                {t}
                            </span>
                        ))}
                    </div>
                </fieldset>
                <button type="submit">Apply</button>
            </form>
    
            <form onSubmit={(e) => { e.preventDefault(); handleFilterByColor(); }}>
                <fieldset>
                    <legend>Filter by Color</legend>
                    <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                        {      
                        colors
                        .map((c, index) => (
                            <span key={c} style={{ margin: '0 10px 10px 0', display: 'flex', alignItems: 'center' }}>
                                <input 
                                    type="checkbox" 
                                    value={c} 
                                    checked={color.includes(c)}
                                    onChange={(e) => {
                                        const selected = e.target.checked;
                                        setColor(prev => 
                                            selected 
                                                ? [...prev, c] 
                                                : prev.filter(item => item !== c)
                                        );
                                    }}
                                />
                                <div 
                                    style={{ 
                                        width: '20px', 
                                        height: '20px', 
                                        backgroundColor: c, 
                                        marginLeft: '5px',
                                        border: '1px solid #000'
                                    }} 
                                />
                                <span style={{ marginLeft: '5px' }}>
                                    {approaches[index]}
                                </span>
                            </span>
                        ))}
                    </div>
                </fieldset>
                <button type="submit">Apply</button>
            </form>
    
            <button onClick={handleApplyAllFilters}>Apply All</button>
            <button onClick={handleResetFilters}>Reset Filters</button>
            <button onClick={() => setShowExportOptions(!showExportOptions)}>Export</button>
            {showExportOptions && (
                <div className="export-options">
                    <button onClick={handleExportCSV}>Export as CSV</button>
                    <button onClick={handleExportPNG}>Export as PNG</button>
                    <button onClick={handleExportPDF}>Export as PDF</button>
                </div>
            )}
            <svg ref={svgRef}></svg>
            <div ref={tooltipRef}></div>
            <button onClick={toggleView}>Toggle View</button>
        </div>
    );
    
    
};

export default GraphVisualization;
