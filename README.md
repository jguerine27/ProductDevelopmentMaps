

# Project Description:
The growth of digital and connectivity technologies within the
industrial landscape, and their integration within products, has led
to the emergence of "multidisciplinary" products that combine
mechanical, electrical, electronic, software and, more broadly,
information and communication technologies. These
multidisciplinary products are more complex, from both a technical
and an organizational perspective. For companies wishing to evolve
their "traditional" product ranges towards multidisciplinary
products, it can represent a major challenge. To support companies
in this evolution, previous research has investigated the evolution
of product development practices from a methodological
standpoint. In particular, this work has led to the creation of
"cartographies", graphically organizing approaches, processes,
methods and tools, and their links for multidisciplinary product
development. Although these cartographies can be seen as a
preliminary database, their main limitation is that they are a
snapshot of the scientific literature. Given this static aspect, it is
not possible, for example, to perform queries on these
cartographies, to display certain branches, or to easily manipulate
these data to generate other results. This research project
addresses an important limitation identified in previous work.
The idea of this project is therefore to explore different types of
representation (ontology, graph-oriented database, other), in order
to determine the most appropriate representation for the project
and apply it by setting up a demonstrator (VOWL/Protected,
GraphQL/Neo4J, etc.).

# Project Goals:
The project aims at promoting prior research and its graphical
maps between approaches, processes, methods and tools through
transferring them into a customizable, dynamic, navigable
representation that can be updated. To do so, the project focuses
on the exploration of different types of representation (ontology,
graph-oriented database, or other), before determining the most
suitable representation for the project needs and setting up a
demonstrator. The latter will integrate core features and set ground
for future developments.
For both the researchers and the industry, this will act as a
repository of commonly discussed approaches, processes, methods
and tools to develop multidisciplinary products, that can be
filtered, searched and updated through a peer-reviewing process.
This is a first step towards supporting the industry in its
transformation of its product development practices. 

# Technology Description:
The front-end is implemented in React.js, a framework for designing and implementing scalable websites which communicates with the back-end. The latter is the core of attention for this research as it supports the implementation of all required functionalities. For this purpose, a significant portion of the development of the dynamic database has been utilised in implementing the functionalities of the database, ensuring Application Programming Interface (API) calls are workable as intended. Therefore, the technology stack chosen for the back-end is Node.js/Express, a scalable framework that is intended to integrate with React.js. The DBMS of the dynamic database is intended to maintain data integrity, and ensure updates made to the database are persistent. The choice of the data representation has already been justified in the previous section. Accordingly, the instantiation of the Graph Database has been done via Neo4j, a scalable and native graph DBMS designed specifically for efficient querying of data stored in the form of graphs. Neo4j's graph database structure closely matches the representation of the initial maps, making it a suitable fit for efficiently modelling and navigating complex relationships. This enables ease of interpolation from the initial maps to the new representation. These technologies, when combined, enable the dynamic representation of concepts and techniques, which justifies their usage in alignment with the main objectives of the project.
# Funding: 
This project was funded by Mitacs Globalink Research Internship.
