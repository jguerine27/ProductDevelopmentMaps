

# Project Description:
The growth of digital and connectivity technologies within the
industrial landscape, and their integration within products, has led
to the emergence of "multidisciplinary" products that combine
mechanical, electrical, electronic, software and, more broadly,
information and communication technologies. To support companies
evolving their "traditional" product ranges towards such products,
design research has produced a large body of approaches, processes,
methods and tools, collectively referred to here as "concepts and
techniques". This support, however, remains underutilised by
industry: practitioners mostly discover methods from coworkers
rather than from the literature, and even once a method is
discovered, selecting one that suits the situation at hand remains
difficult because repositories describe methods rather than their
use in context. There is, in short, a gap of knowledge transfer
between design research and engineering practice.

Previous work addressed part of this gap. Guérineau et al. (2022)
organised over 200 concepts and techniques, drawn from 167
publications, into three "maps" covering mechatronic products,
cyber-physical systems and smart products, classifying each of them
into four levels (approach, process, method, tool) and linking those
that are jointly used. Because these maps were static, Bilal et al.
(2025) turned them into a demonstrator of a community-driven dynamic
database (V1) in which the maps could be filtered by reference, tag,
keyword, year and related approach, and in which users could propose
additions or modifications subject to peer review. V1 nevertheless
left several limitations open: it offered no support for selecting a
concept or technique for a given industrial context, the concepts
and techniques carried no descriptions, the user interface and user
experience were limited, the database was not fully populated, and
the demonstrator was never deployed.

This repository holds the second version (V2) of that demonstrator,
which addresses those limitations and turns the maps into a
collaborative platform for the navigation, comprehension and
selection of concepts and techniques for multidisciplinary product
development.

# Project Goals:
The project aims at bridging the gap between design research and
engineering practice by making the maps of concepts and techniques
not only navigable but also understandable, selectable and
sustainable. Three design objectives guide the work:

- **Improve comprehension.** Every concept and technique carries a
  description card whose structure follows its level in the
  hierarchical model: an approach is described through its
  principles, a process through its model representation, a method
  through its rules and engineering practices, and a tool through
  its materialisation as a form, a matrix or a diagram. Each
  description is backed by at least one literature source and is
  accompanied by comments from industry peers sharing their
  experience of selecting, implementing and adapting the concept, by
  a criteria-based rating covering the effect on product quality,
  the effect on the design process, the dependency on resources and
  the efficacy of the concept after use, by user-generated
  (folksonomy) tags, and by the references that expressly cite it.
- **Support selection.** Challenges, that is, formulated statements
  of difficulties encountered by an engineering department during
  product development, are stored as first-class elements and linked
  to every concept and technique able to address them. Selecting one
  or more challenges highlights the responding concepts within the
  map while the surrounding structure stays visible at reduced
  contrast, with a side panel listing the results grouped by
  challenge and a choice between matching any or all of the selected
  challenges. This turns an association that previously required an
  expert's mediation into one that any user can query.
- **Establish a collaborative platform.** Any user can propose
  additions or modifications to the maps, covering the concepts and
  techniques, their links, the supporting references, their
  descriptions and the challenges they address. Proposals do not
  take effect immediately: each one is reviewed by a peer reviewer
  who may accept it, reject it, or send it back for improvement with
  feedback, and contributors can follow the status of their
  proposals at any time. Reviewers authenticate through their ORCID
  account, tying every review to a verified academic identity.

Alongside these objectives, the maps have been redesigned in a
circular layout with the four levels arranged as concentric rings,
so that content originally spread over eight figures can be read in
a single view and the three product-type maps can be displayed
either combined or separately. The filtering and export capabilities
of V1 are retained, the database has been fully populated from the
source maps, and the platform is deployed and publicly accessible as
an online beta.

For both the researchers and the industry, this acts as a repository
of commonly discussed approaches, processes, methods and tools to
develop multidisciplinary products, that can be filtered, searched,
compared, selected against real industrial challenges and updated
through a peer-reviewing process.

# Technology Description:
The front-end is implemented in React.js, a framework for designing
and implementing scalable websites which communicates with the
back-end. The circular, multi-level map and its filtering,
highlighting and challenge-selection interactions are rendered with
D3.js, and the export of the maps is handled client-side. The
back-end remains the core of attention for this research as it
supports the implementation of all required functionalities, and the
technology stack chosen for it is Node.js/Express, a scalable
framework that integrates well with React.js. The DBMS maintains
data integrity and ensures that updates made to the database are
persistent. Accordingly, the instantiation of the Graph Database has
been done via Neo4j, a scalable and native graph DBMS designed
specifically for efficient querying of data stored in the form of
graphs. Neo4j's graph structure closely matches the representation
of the initial maps, making it a suitable fit for efficiently
modelling and navigating complex relationships, and it extends
naturally to the elements introduced in V2: descriptions, comments,
ratings, folksonomy tags, challenges and the proposal and review
workflow are all modelled as nodes and relationships alongside the
concepts and techniques themselves.

Contribution and review are protected by an authorisation boundary
applied at the router level, so that reading the maps stays entirely
public while any write requires an account. Reviewer identity is
established through ORCID OAuth 2.0 using the authenticate scope
only, with the code-for-token exchange performed server-side, and
sessions are carried in signed cookies whose role is re-read from
the database on every request so that a change of privileges takes
effect immediately. The whole stack, comprising the Neo4j instance,
the Express API and an nginx-served production build of the
front-end, is containerised with Docker and orchestrated through
Docker Compose, which is what makes the public beta deployment
reproducible.

These technologies, when combined, enable the dynamic
representation, selection and collaborative maintenance of concepts
and techniques, which justifies their usage in alignment with the
main objectives of the project.

# Funding:
This project was funded by Mitacs Globalink Research Internship.
