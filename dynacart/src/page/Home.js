import React, { useState } from 'react';
import Navbar from '../Components/Navbar/Navbar';
import AddNodeForm from '../Components/AddNodeForm/AddNodeForm';
import AddReferenceForm from '../Components/AddReferenceForm/AddReferenceForm';
import GraphVisualization from '../Components/GraphVisualization/GraphVisualization';
import {  signOut } from "firebase/auth";
import {auth} from '../firebase';
import { useNavigate } from 'react-router-dom';
import ReviewableNodes from '../Components/ReviewNodes/ReviewableNodes';
import ReviewReferences from '../Components/ReviewReference/ReviewReferences';
import DeleteOption from '../Components/DeleteOption/DeleteOption';
import UpdateNode from '../Components/UpdateNode/UpdateNode';
 
const Home = () => {
    const navigate = useNavigate();
 
        const handleLogout = () => {
            // Clear ORCID authentication state
            localStorage.removeItem('orcidAuth');
            
            // Clear any other session or authentication states if needed
            
            
                      
        signOut(auth).then(() => {
        // Sign-out successful.
            navigate("/");
            console.log("Signed out successfully")
        }).catch((error) => {
        // An error happened.
        });
    }

    const [activeForm, setActiveForm] = useState('graph');

    return (
        <div>
            <Navbar setActiveForm={setActiveForm} />
            {activeForm === 'home' && <h1>Welcome to DynaCart</h1>}
            {activeForm === 'node' && <AddNodeForm />}
            {activeForm === 'reference' && <AddReferenceForm />}
            {activeForm === 'graph' && <GraphVisualization />}
            {activeForm === 'reviewNode' && <ReviewableNodes />}
            {activeForm === 'reviewReference' && <ReviewReferences />}
            {activeForm === 'delete' && <DeleteOption />}
            {activeForm === 'updateNode' && <UpdateNode/>}

            <button onClick={handleLogout}>Logout</button>

        </div>
    );
}
 
export default Home;