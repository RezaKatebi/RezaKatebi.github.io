// Smooth scrolling for navigation links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        document.querySelector(this.getAttribute('href')).scrollIntoView({
            behavior: 'smooth'
        });
    });
});

// Visit counter
async function updateVisitCounter() {
    try {
        const response = await fetch('/api/visit-counter', { method: 'POST' });
        const data = await response.json();
        document.getElementById('visit-count').textContent = data.count;
    } catch (error) {
        console.error('Error updating visit count:', error);
    }
}

// Comments
document.getElementById('comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const comment = document.getElementById('comment-text').value;
    try {
        await fetch('/api/comments', {
            method: 'POST',
            body: JSON.stringify({ comment }),
            headers: { 'Content-Type': 'application/json' }
        });
        document.getElementById('comment-text').value = '';
        await loadComments();
    } catch (error) {
        console.error('Error posting comment:', error);
    }
});

async function loadComments() {
    try {
        const response = await fetch('/api/comments');
        const comments = await response.json();
        const commentList = document.getElementById('comment-list');
        commentList.innerHTML = comments.map(c => `
            <div class="comment" style="opacity: 0;">
                <p>${c.text}</p>
                <small>${new Date(c.date).toLocaleString()}</small>
            </div>
        `).join('');
        
        // Fade in comments
        commentList.querySelectorAll('.comment').forEach((comment, index) => {
            setTimeout(() => {
                comment.style.transition = 'opacity 0.5s ease';
                comment.style.opacity = 1;
            }, index * 100);
        });
    } catch (error) {
        console.error('Error loading comments:', error);
    }
}

// Blog posts
async function loadBlogPosts() {
    try {
        // Include your original blog post along with the sample posts
        const posts = [
            { 
                id: 1, 
                title: "Astrophysics and AI: My Journey from Stars to Self-Driving Cars", 
                excerpt: "As an astrophysicist turned AI engineer, I've had a unique journey that's taken me from studying the cosmos to developing cutting-edge autonomous driving technology at Tesla. In this post, I reflect on this transition and how my background in astrophysics has influenced my approach to AI and machine learning in the automotive industry.",
                date: "2023-05-15"
            },
            { id: 2, title: "My Journey in AI", excerpt: "Exploring the fascinating world of artificial intelligence and its impact on our daily lives." },
            { id: 3, title: "Tesla's Autopilot: Behind the Scenes", excerpt: "A deep dive into the technology powering Tesla's revolutionary Autopilot system." },
            { id: 4, title: "The Future of Autonomous Driving", excerpt: "Predictions and insights on where the self-driving car industry is headed." }
        ];

        const blogPosts = document.getElementById('blog-posts');
        blogPosts.innerHTML = posts.map(p => `
            <article class="blog-post" style="opacity: 0;">
                <h3>${p.title}</h3>
                <p>${p.excerpt}</p>
                <small>${p.date ? new Date(p.date).toLocaleDateString() : ''}</small>
                <a href="/blog/${p.id}" class="read-more">Read more</a>
            </article>
        `).join('');
        
        // Fade in blog posts
        blogPosts.querySelectorAll('.blog-post').forEach((post, index) => {
            setTimeout(() => {
                post.style.transition = 'opacity 0.5s ease';
                post.style.opacity = 1;
            }, index * 200);
        });
    } catch (error) {
        console.error('Error loading blog posts:', error);
    }
}

// Research projects
async function loadResearchProjects() {
    try {
        // In a real application, you would fetch this data from your API
        const projects = [
            {
                title: "Gravitational Waves from Eccentric Binary Black Holes",
                description: "Investigated the gravitational wave emissions from eccentric binary black hole systems using numerical relativity simulations.",
                tags: ["Astrophysics", "Gravitational Waves", "Numerical Relativity"]
            },
            {
                title: "Machine Learning in Cosmology",
                description: "Applied machine learning techniques to analyze large-scale structure data and constrain cosmological parameters.",
                tags: ["Cosmology", "Machine Learning", "Data Analysis"]
            },
            // Add more research projects as needed
        ];

        const researchProjects = document.getElementById('research-projects');
        researchProjects.innerHTML = projects.map(p => `
            <article class="research-project" style="opacity: 0;">
                <h3>${p.title}</h3>
                <p>${p.description}</p>
                <div class="tags">
                    ${p.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}
                </div>
            </article>
        `).join('');
        
        // Fade in research projects
        researchProjects.querySelectorAll('.research-project').forEach((project, index) => {
            setTimeout(() => {
                project.style.transition = 'opacity 0.5s ease';
                project.style.opacity = 1;
            }, index * 200);
        });
    } catch (error) {
        console.error('Error loading research projects:', error);
    }
}

// Initialize
updateVisitCounter();
loadComments();
loadBlogPosts();
loadResearchProjects();

// Intersection Observer for fade-in animations
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('fade-in');
        }
    });
}, { threshold: 0.1 });

document.querySelectorAll('section').forEach(section => {
    observer.observe(section);
});