import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { saveAs } from 'file-saver';
import ExportMenu from './ExportMenu';

jest.mock('file-saver', () => ({ saveAs: jest.fn() }));

/** jsdom's Blob has no .text(), so the body comes back through a FileReader. */
const readBlob = (blob) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(blob);
    });

/** Reads back what saveAs was handed, so the CSV body itself can be asserted. */
async function exportedCsv() {
    expect(saveAs).toHaveBeenCalledTimes(1);
    const [blob, filename] = saveAs.mock.calls[0];
    return { text: await readBlob(blob), filename };
}

const BLOCKS = [
    {
        name: 'Systems engineering',
        level: 'Approach',
        maps: ['C', 'M', 'S'],
        related_approach: 'Systems Engineering',
        color: '#08b4f4',
        citations: 'Sünnetcioglu et al., 2016; Tomiyama et al., 2019',
        tags: [],
        status: 'approved',
        degree: 7,
    },
    {
        name: 'Integrated product process and manufacturing system development (IPPMD)',
        level: 'Method',
        maps: ['M'],
        related_approach: 'Concurrent Engineering',
        color: '#f39c12',
        citations: '',
        tags: ['reserved'],
        status: 'approved',
        degree: 0,
    },
];

beforeEach(() => {
    saveAs.mockReset();
});

it('exports the new block schema, with no undefined columns', async () => {
    render(<ExportMenu blocks={BLOCKS} edges={[]} meta={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('button', { name: /CSV/ }));

    const { text, filename } = await exportedCsv();
    const [header, ...rows] = text.trim().split(/\r?\n/);

    expect(filename).toBe('graph_data.csv');
    expect(header).toBe('Name,Level,Approach,Maps,Color,Citations,Tags');
    // The old export read node.label / node.approach / node.map / node.type,
    // none of which exist any more, and wrote a file of undefineds.
    expect(text).not.toContain('undefined');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Systems engineering');
    expect(rows[0]).toContain('Approach');
    expect(rows[0]).toContain('C; M; S');
    expect(rows[0]).toContain('#08b4f4');
});

it('quotes a citation string containing commas rather than splitting it', async () => {
    render(<ExportMenu blocks={BLOCKS} edges={[]} meta={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('button', { name: /CSV/ }));

    const { text } = await exportedCsv();
    expect(text).toContain('"Sünnetcioglu et al., 2016; Tomiyama et al., 2019"');
});

it('exports exactly what is on screen, not the unfiltered map', async () => {
    // `blocks` is the filtered result: all filtering is server-side.
    render(<ExportMenu blocks={[BLOCKS[0]]} edges={[]} meta={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('button', { name: /1 blocks/ }));

    const { text } = await exportedCsv();
    expect(text.trim().split(/\r?\n/)).toHaveLength(2);
    expect(text).not.toContain('IPPMD');
});

it('writes a header-only file when the filter matched nothing', async () => {
    render(<ExportMenu blocks={[]} edges={[]} meta={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('button', { name: /CSV/ }));

    const { text } = await exportedCsv();
    expect(text.trim()).toBe('');
});
