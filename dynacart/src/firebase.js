// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
//import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAcibsM14IH7pWItBF4v93WOC0NdiOkbuA",
  authDomain: "dynacart-ba40e.firebaseapp.com",
  projectId: "dynacart-ba40e",
  storageBucket: "dynacart-ba40e.appspot.com",
  messagingSenderId: "741916921699",
  appId: "1:741916921699:web:310d3991eeea620ac1cd56",
  measurementId: "G-HE76JP5B9Q"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
//const analytics = getAnalytics(app);

export const auth = getAuth(app);
export default app;