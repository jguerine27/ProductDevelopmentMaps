import React, { useState } from 'react';
import './Home.css';
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
        <div className="app-shell">
            <Navbar
                setActiveForm={setActiveForm}
                activeForm={activeForm}
                onLogout={handleLogout}
            />
            <div className="app-shell-view">
                {activeForm === 'home' && <h1>Welcome to DynaCart</h1>}
                {activeForm === 'node' && <AddNodeForm />}
                {activeForm === 'reference' && <AddReferenceForm />}
                {activeForm === 'graph' && <GraphVisualization />}
                {activeForm === 'reviewNode' && <ReviewableNodes />}
                {activeForm === 'reviewReference' && <ReviewReferences />}
                {activeForm === 'delete' && <DeleteOption />}
                {activeForm === 'updateNode' && <UpdateNode/>}
            </div>
        </div>
    );
}
 
export default Home;