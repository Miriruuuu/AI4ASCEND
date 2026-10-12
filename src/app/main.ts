import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

const app = createApp(App)
app.mount('#app')
console.info('[connect4] app mounted')
