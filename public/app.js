document.addEventListener('DOMContentLoaded', async () => {
    // Ambil sessionId dari path /d/:sessionId
    const pathSegments = window.location.pathname.split('/').filter(Boolean);
    const sessionId = pathSegments[pathSegments.length - 1];

    const sessionSubtitle = document.getElementById('sessionSubtitle');
    const sessionStatusCard = document.getElementById('sessionStatusCard');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const guestNameBadge = document.getElementById('guestNameBadge');
    const expiryTimeBadge = document.getElementById('expiryTimeBadge');
    const adminHelpCard = document.getElementById('adminHelpCard');
    const btnChatAdmin = document.getElementById('btnChatAdmin');

    const btnDownloadAll = document.getElementById('btnDownloadAll');
    const frameSection = document.getElementById('frameSection');
    const frameImg = document.getElementById('frameImg');
    const btnDownloadFrame = document.getElementById('btnDownloadFrame');
    const gifSection = document.getElementById('gifSection');
    const gifImg = document.getElementById('gifImg');
    const btnDownloadGif = document.getElementById('btnDownloadGif');
    const rawSection = document.getElementById('rawSection');
    const rawGrid = document.getElementById('rawGrid');

    if (!sessionId) {
        sessionSubtitle.textContent = 'Sesi tidak valid';
        return;
    }

    sessionSubtitle.textContent = `ID Sesi: ${sessionId}`;

    // Pasang tombol Download All ZIP
    btnDownloadAll.addEventListener('click', () => {
        window.location.href = `/api/session/${encodeURIComponent(sessionId)}/zip`;
    });

    try {
        const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}/details`);
        const data = await response.json();

        if (!data.ok) {
            sessionSubtitle.textContent = 'Gagal memuat detail sesi.';
            return;
        }

        // Tampilkan Card Status & Informasi Tamu
        sessionStatusCard.style.display = 'flex';
        guestNameBadge.textContent = `Tamu: ${data.userName || 'GUEST'}`;

        if (data.isExpired) {
            statusDot.className = 'status-dot danger';
            statusText.textContent = 'Masa Unduh Telah Kedaluwarsa';
            expiryTimeBadge.textContent = 'Telah Kedaluwarsa';
        } else if (data.daysRemaining <= 1) {
            statusDot.className = 'status-dot warning';
            statusText.textContent = 'Masa Unduh Segera Berakhir';
            expiryTimeBadge.textContent = `Tersisa ${data.hoursRemaining || 24} Jam`;
        } else {
            statusDot.className = 'status-dot';
            statusText.textContent = 'Masa Unduh Aktif';
            expiryTimeBadge.textContent = `Tersisa ${data.daysRemaining} Hari`;
        }

        // Pasang link bantuan admin
        if (data.adminWhatsApp) {
            adminHelpCard.style.display = 'block';
            const textWa = encodeURIComponent(
                `Halo Admin Diceritakita, saya ingin bertanya seputar file foto photobox event saya atas nama ${data.userName} (ID Sesi: ${sessionId}).`
            );
            btnChatAdmin.href = `https://wa.me/${data.adminWhatsApp}?text=${textWa}`;
        }

        // 1. Tampilkan Foto Berbingkai
        if (data.frame) {
            frameImg.src = data.frame;
            btnDownloadFrame.href = data.frame;
            btnDownloadFrame.setAttribute('download', `Photobox_${data.userName || 'Event'}_${sessionId}_Frame.png`);
            frameSection.style.display = 'block';
        }

        // 2. Tampilkan GIF
        if (data.gif) {
            gifImg.src = data.gif;
            btnDownloadGif.href = data.gif;
            btnDownloadGif.setAttribute('download', `Photobox_${data.userName || 'Event'}_${sessionId}_Animasi.gif`);
            gifSection.style.display = 'block';
        }

        // 3. Tampilkan Foto Mentah
        if (data.rawPhotos && data.rawPhotos.length > 0) {
            rawGrid.innerHTML = '';
            data.rawPhotos.forEach((photoUrl, index) => {
                const card = document.createElement('div');
                card.className = 'raw-card';
                card.innerHTML = `
                    <img src="${photoUrl}" alt="Foto ${index + 1}" loading="lazy">
                    <a href="${photoUrl}" download="Foto_${data.userName || 'Tamu'}_${index + 1}.jpg" class="btn btn-sm">
                        ⬇️ Unduh Foto ${index + 1}
                    </a>
                `;
                rawGrid.appendChild(card);
            });
            rawSection.style.display = 'block';
        }

    } catch (err) {
        console.error('Gagal mengambil data sesi:', err);
        sessionSubtitle.textContent = 'Gagal terhubung ke server.';
    }
});
