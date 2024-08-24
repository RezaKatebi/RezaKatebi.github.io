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
        const posts = [
            { 
                id: 1, 
                title: "Consciousness",
                excerpt: "Exploring the nature of consciousness and its implications.",
                date: "2023-05-15",
                url: "pages/blog/posts/Consciousness.html"
            }
        ];

        const blogPosts = document.getElementById('blog-posts');
        blogPosts.innerHTML = posts.map(p => `
            <article class="blog-post" style="opacity: 0;">
                <h3>${p.title}</h3>
                <p>${p.excerpt}</p>
                <small>${p.date ? new Date(p.date).toLocaleDateString() : ''}</small>
                <a href="${p.url}" class="read-more">Read more</a>
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

// Initialize
updateVisitCounter();
loadComments();
loadBlogPosts();

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