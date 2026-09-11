import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import AppShell from '../Components/AppShell/AppShell';
import GraphVisualization from '../Components/GraphVisualization/GraphVisualization';

/**
 * The map, and the page under the shared shell.
 *
 * PUBLIC. Reading the cartographies needs no account, so nothing here waits on
 * the session and nothing is hidden while it loads — the graph starts fetching
 * immediately and the navbar fills its account slot when /api/auth/me answers.
 *
 * ── THE SHELL IS NO LONGER THIS PAGE'S ───────────────────────────────────────
 * The navbar and the account wiring used to live here, which is precisely why
 * they disappeared the moment anyone left /map. They are AppShell's now, and
 * Collaborate and Review wear the same frame.
 *
 * This page used to own a second section too — the bar's Home, a bare "Welcome
 * to DynaCart" heading shown in place while the URL stayed on /map. The landing
 * page at / replaced it, so the bar's Home navigates there and only the graph is
 * left here. `activeForm` stays because the bar still needs to know which
 * section is showing, and because Collaborate and Review pass their own ids.
 *
 * A section asked for from another page arrives in location state, since there
 * is no URL to carry it — the shell navigates here and names the section it
 * wanted. Read once, as the initial value: after that the bar sets it directly.
 *
 * The six legacy CRUD screens (AddNodeForm, AddReferenceForm, ReviewableNodes,
 * ReviewReferences, DeleteOption, UpdateNode) used to be mounted here. They call
 * routes that no longer exist and are being replaced rather than repaired, so
 * they are no longer imported — importing them would bundle broken code and pull
 * their global CSS into every page. The files are left untouched on disk.
 */
const Home = () => {
    const location = useLocation();
    const [activeForm, setActiveForm] = useState(() => location.state?.form || 'graph');

    return (
        <AppShell activeForm={activeForm} setActiveForm={setActiveForm}>
            {activeForm === 'graph' && <GraphVisualization />}
        </AppShell>
    );
};

export default Home;
