import React, { useState } from 'react';
import { saveAs } from 'file-saver'; // For file download
import Papa from 'papaparse'; // For CSV export
import jsPDF from 'jspdf'; // For PDF export

/**
 * The sidebar now renders its own inline SVG (the magnifier icon), so the image
 * exports have to name the map rather than take the first SVG on the page.
 */
const GRAPH_SVG_SELECTOR = '.pdm-svg';
/** The zoomed group; its untransformed bounding box is the whole map. */
const GRAPH_ROOT_SELECTOR = '.pdm-root';
const EXPORT_MARGIN = 48;
const EXPORT_MAX_PIXELS = 3000;

/**
 * Rasterises the whole map, not the part of it currently on screen.
 *
 * The SVG element is only as big as its panel and its contents are moved around
 * by the zoom transform, so capturing the element gives whatever the user
 * happens to be looking at — which is how a PDF ended up holding a corner of the
 * map. getBBox on the zoomed group reports the drawn extent in the group's own
 * coordinates, before that transform, and re-framing a detached copy on that box
 * captures everything at any zoom level.
 */
function rasteriseMap() {
    const svgElement = document.querySelector(GRAPH_SVG_SELECTOR);
    const root = svgElement && svgElement.querySelector(GRAPH_ROOT_SELECTOR);
    if (!root) return Promise.reject(new Error('The map is not on screen.'));

    const box = root.getBBox();
    if (!box.width || !box.height) return Promise.reject(new Error('The map is empty.'));

    const width = box.width + EXPORT_MARGIN * 2;
    const height = box.height + EXPORT_MARGIN * 2;
    // Cap the raster so a 2000px-wide map does not produce a huge file.
    const scale = Math.min(EXPORT_MAX_PIXELS / Math.max(width, height), 2);

    const clone = svgElement.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.querySelector(GRAPH_ROOT_SELECTOR).removeAttribute('transform');
    clone.setAttribute('viewBox', `${box.x - EXPORT_MARGIN} ${box.y - EXPORT_MARGIN} ${width} ${height}`);
    // Without explicit width and height the standalone SVG has no intrinsic
    // size and the browser rasterises it at a 300x150 default.
    clone.setAttribute('width', width);
    clone.setAttribute('height', height);

    const svgString = new XMLSerializer().serializeToString(clone);
    const DOMURL = window.URL || window.webkitURL || window;
    const url = DOMURL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }));

    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(width * scale);
            canvas.height = Math.round(height * scale);

            const context = canvas.getContext('2d');
            context.fillStyle = 'white';
            context.fillRect(0, 0, canvas.width, canvas.height);
            // Explicit destination size, so the source is scaled to fill the
            // canvas rather than drawn at whatever size the browser inferred.
            context.drawImage(image, 0, 0, canvas.width, canvas.height);

            DOMURL.revokeObjectURL(url);
            resolve({ canvas, width, height });
        };
        image.onerror = () => {
            DOMURL.revokeObjectURL(url);
            reject(new Error('The map could not be rasterised.'));
        };
        image.src = url;
    });
}

const ExportMenu = ({ blocks, edges, meta }) => {
    const [showExportOptions, setShowExportOptions] = useState(false);

    const handleExportCSV = () => {
        // `blocks` is already the filtered result — all filtering is server-side,
        // so whatever is on screen is exactly what gets exported.
        const rows = (blocks || []).map((block) => ({
            Name: block.name,
            Level: block.level,
            Approach: block.related_approach,
            Maps: (block.maps || []).join('; '),
            Color: block.color,
            Citations: block.citations || '',
            Tags: (block.tags || []).join('; '),
        }));

        const csvData = Papa.unparse(rows);
        const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
        saveAs(blob, 'graph_data.csv');
    };

    const handleExportPNG = () => {
        rasteriseMap()
            .then(({ canvas }) => {
                const link = document.createElement('a');
                link.download = 'graph_image.png';
                link.href = canvas.toDataURL('image/png');
                link.click();
            })
            .catch((error) => console.error('Error exporting as PNG:', error.message));
    };

    const handleExportPDF = () => {
        rasteriseMap()
            .then(({ canvas, width, height }) => {
                // jsPDF reorders an explicit format array to match the
                // orientation, so asking for 'portrait' with a landscape map
                // silently swapped the page and clipped everything past the
                // shorter edge — which is what cropped the exported map.
                const pdf = new jsPDF({
                    orientation: width >= height ? 'landscape' : 'portrait',
                    unit: 'px',
                    format: [width, height],
                });

                pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, width, height);
                pdf.save('graph_image.pdf');
            })
            .catch((error) => console.error('Error exporting as PDF:', error.message));
    };

    const blockCount = blocks?.length || 0;
    const edgeCount = edges?.length || 0;

    return (
        <div className="pdm-export">
            <button
                type="button"
                className="pdm-export-toggle"
                onClick={() => setShowExportOptions(!showExportOptions)}
                aria-expanded={showExportOptions}
            >
                Export <span aria-hidden="true">▾</span>
            </button>
            {showExportOptions && (
                <div className="pdm-export-options">
                    <button type="button" onClick={handleExportCSV}>
                        CSV <span>{blockCount} blocks</span>
                    </button>
                    <button type="button" onClick={handleExportPNG}>PNG</button>
                    <button type="button" onClick={handleExportPDF}>PDF</button>
                    {meta?.evidence_filter_active && (
                        <p className="pdm-export-note">
                            {edgeCount} connections under the active reference filter
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};

export default ExportMenu;
