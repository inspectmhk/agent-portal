document.addEventListener('DOMContentLoaded', () => {
  const shareBtn = document.getElementById('statusShareBtn');
  if (!shareBtn) return;

  shareBtn.addEventListener('click', async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: document.title,
          url: window.location.href
        });
      } catch (err) {
        // User canceled share sheet
      }
    } else if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(window.location.href);
        alert('Link copied to clipboard!');
      } catch (err) {
        alert('Could not copy link');
      }
    }
  });
});